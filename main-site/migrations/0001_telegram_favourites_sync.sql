-- ============================================================================
-- SG Bike Parking Finder
-- Migration 0001: Telegram favourites sync
--
-- Table prefix: sgbp_
--
-- What this adds
--   Favourites that survive a lost device, synced between the web app and the
--   Telegram bot. There is no account system and no Supabase Auth involved.
--   A browser proves who it is with a device id plus a device secret, and a
--   Telegram user is identified by their Telegram id. Linking the two merges
--   both favourite sets into the Telegram-owned set.
--
-- Security model
--   Every table has RLS enabled with no policies at all. That denies the anon
--   and authenticated roles outright. Only the service role, used from the
--   Vercel serverless functions and from the bot on the VPS, can reach these
--   tables. Never expose SUPABASE_SERVICE_KEY to the browser.
--
-- Run this in the Supabase SQL editor, or with the Supabase CLI:
--   supabase db execute --file migrations/0001_telegram_favourites_sync.sql
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Devices: one row per browser session that has ever saved a favourite.
-- secret_hash is sha256 of the secret the browser keeps in localStorage.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_devices (
    id           uuid primary key default gen_random_uuid(),
    secret_hash  text        not null,
    label        text,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Telegram users: created the first time someone talks to the bot.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_telegram_users (
    telegram_id bigint primary key,
    username    text,
    first_name  text,
    settings    jsonb       not null default
                '{"radius": 0.5, "sheltered_only": false, "result_limit": 5}'::jsonb,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Links: a device points at exactly one Telegram user, and one Telegram user
-- may own many devices. That is what lets a single Telegram account sync with
-- more than one site session.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_links (
    device_id   uuid primary key references sgbp_devices(id) on delete cascade,
    telegram_id bigint      not null references sgbp_telegram_users(telegram_id) on delete cascade,
    linked_at   timestamptz not null default now(),
    linked_via  text        not null default 'deeplink'
                check (linked_via in ('deeplink', 'backup_code'))
);
create index if not exists sgbp_links_telegram_id_idx on sgbp_links (telegram_id);

-- ---------------------------------------------------------------------------
-- Link tokens: single use, short lived, carried in the t.me start payload.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_link_tokens (
    token       text primary key,
    device_id   uuid        not null references sgbp_devices(id) on delete cascade,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null default (now() + interval '15 minutes'),
    consumed_at timestamptz,
    consumed_by bigint
);
create index if not exists sgbp_link_tokens_device_id_idx on sgbp_link_tokens (device_id);

-- ---------------------------------------------------------------------------
-- Favourites: owned by exactly one of a device or a Telegram user.
-- Before linking, a browser owns its own rows and the bot owns its own rows.
-- Linking moves the device rows across and drops duplicates by parking code.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_favourites (
    id          uuid primary key default gen_random_uuid(),
    device_id   uuid references sgbp_devices(id) on delete cascade,
    telegram_id bigint references sgbp_telegram_users(telegram_id) on delete cascade,
    code        text        not null,
    description text,
    rack_type   text,
    rack_count  integer,
    sheltered   boolean     not null default false,
    latitude    double precision,
    longitude   double precision,
    created_at  timestamptz not null default now(),
    constraint sgbp_favourites_single_owner
        check (num_nonnulls(device_id, telegram_id) = 1)
);

-- Deduplication is enforced by the database, not by application code.
create unique index if not exists sgbp_favourites_device_code_key
    on sgbp_favourites (device_id, code) where device_id is not null;
create unique index if not exists sgbp_favourites_telegram_code_key
    on sgbp_favourites (telegram_id, code) where telegram_id is not null;

-- ---------------------------------------------------------------------------
-- Backup code approval requests.
-- The site asks for codes, the bot asks the human to approve, and only then
-- does the site get to see the codes.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_backup_requests (
    id          uuid primary key default gen_random_uuid(),
    telegram_id bigint      not null references sgbp_telegram_users(telegram_id) on delete cascade,
    device_id   uuid        not null references sgbp_devices(id) on delete cascade,
    status      text        not null default 'pending'
                check (status in ('pending', 'notified', 'approved', 'declined', 'expired', 'consumed')),
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null default (now() + interval '10 minutes'),
    notified_at timestamptz,
    decided_at  timestamptz,
    chat_id     bigint,
    message_id  bigint
);
create index if not exists sgbp_backup_requests_pending_idx
    on sgbp_backup_requests (status, created_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Backup codes: only the sha256 hash is ever stored. Single use.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_backup_codes (
    id           uuid primary key default gen_random_uuid(),
    telegram_id  bigint      not null references sgbp_telegram_users(telegram_id) on delete cascade,
    batch_id     uuid        not null,
    code_hash    text        not null unique,
    created_at   timestamptz not null default now(),
    used_at      timestamptz,
    used_by      uuid references sgbp_devices(id) on delete set null
);
create index if not exists sgbp_backup_codes_telegram_id_idx
    on sgbp_backup_codes (telegram_id) where used_at is null;

-- ============================================================================
-- Functions
--
-- The interesting operations are atomic and live in the database, so the bot
-- and the serverless functions cannot leave half finished state behind if a
-- request dies partway.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Move every device favourite onto the Telegram user, skipping codes the
-- Telegram user already has. Returns how many moved and how many were already
-- there.
-- ---------------------------------------------------------------------------
create or replace function sgbp_merge_favourites(
    p_device_id   uuid,
    p_telegram_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_moved     integer := 0;
    v_duplicate integer := 0;
begin
    -- Codes the Telegram user already holds are dropped rather than moved.
    with dupes as (
        delete from sgbp_favourites d
        where d.device_id = p_device_id
          and exists (
              select 1 from sgbp_favourites t
              where t.telegram_id = p_telegram_id
                and t.code = d.code
          )
        returning 1
    )
    select count(*) into v_duplicate from dupes;

    with moved as (
        update sgbp_favourites
        set device_id = null,
            telegram_id = p_telegram_id
        where device_id = p_device_id
        returning 1
    )
    select count(*) into v_moved from moved;

    return jsonb_build_object(
        'merged', v_moved,
        'duplicates', v_duplicate
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- The whole deep link handshake in one atomic call. The bot passes the start
-- payload it received, and gets back either an error or a summary to show.
-- ---------------------------------------------------------------------------
create or replace function sgbp_consume_link_token(
    p_token       text,
    p_telegram_id bigint,
    p_username    text default null,
    p_first_name  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_token  sgbp_link_tokens%rowtype;
    v_merge  jsonb;
    v_total  integer;
    v_devices integer;
begin
    select * into v_token
    from sgbp_link_tokens
    where token = p_token
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'unknown_token');
    end if;

    if v_token.consumed_at is not null then
        return jsonb_build_object('ok', false, 'error', 'already_used');
    end if;

    if v_token.expires_at < now() then
        return jsonb_build_object('ok', false, 'error', 'expired');
    end if;

    -- Make sure the Telegram user exists before anything references it.
    insert into sgbp_telegram_users (telegram_id, username, first_name)
    values (p_telegram_id, p_username, p_first_name)
    on conflict (telegram_id) do update
        set username   = coalesce(excluded.username, sgbp_telegram_users.username),
            first_name = coalesce(excluded.first_name, sgbp_telegram_users.first_name),
            updated_at = now();

    -- Re-linking a device that already points somewhere else just repoints it.
    insert into sgbp_links (device_id, telegram_id, linked_via)
    values (v_token.device_id, p_telegram_id, 'deeplink')
    on conflict (device_id) do update
        set telegram_id = excluded.telegram_id,
            linked_at   = now(),
            linked_via  = 'deeplink';

    v_merge := sgbp_merge_favourites(v_token.device_id, p_telegram_id);

    update sgbp_link_tokens
    set consumed_at = now(),
        consumed_by = p_telegram_id
    where token = p_token;

    select count(*) into v_total
    from sgbp_favourites where telegram_id = p_telegram_id;

    select count(*) into v_devices
    from sgbp_links where telegram_id = p_telegram_id;

    return jsonb_build_object(
        'ok', true,
        'device_id', v_token.device_id,
        'merged', v_merge -> 'merged',
        'duplicates', v_merge -> 'duplicates',
        'total', v_total,
        'devices', v_devices
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Unlink one device. The Telegram favourites are copied back down onto the
-- device first, so nobody loses their list by unlinking.
-- ---------------------------------------------------------------------------
create or replace function sgbp_unlink_device(
    p_device_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_telegram_id bigint;
    v_copied      integer := 0;
begin
    select telegram_id into v_telegram_id
    from sgbp_links where device_id = p_device_id;

    if v_telegram_id is null then
        return jsonb_build_object('ok', false, 'error', 'not_linked');
    end if;

    with copied as (
        insert into sgbp_favourites
            (device_id, code, description, rack_type, rack_count, sheltered, latitude, longitude)
        select p_device_id, code, description, rack_type, rack_count, sheltered, latitude, longitude
        from sgbp_favourites
        where telegram_id = v_telegram_id
        on conflict do nothing
        returning 1
    )
    select count(*) into v_copied from copied;

    delete from sgbp_links where device_id = p_device_id;

    return jsonb_build_object('ok', true, 'kept', v_copied, 'telegram_id', v_telegram_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Unlink every device belonging to a Telegram user. Used by /unlink in chat.
-- ---------------------------------------------------------------------------
create or replace function sgbp_unlink_all(
    p_telegram_id bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_device  record;
    v_devices integer := 0;
begin
    for v_device in
        select device_id from sgbp_links where telegram_id = p_telegram_id
    loop
        perform sgbp_unlink_device(v_device.device_id);
        v_devices := v_devices + 1;
    end loop;

    return jsonb_build_object('ok', true, 'devices', v_devices);
end;
$$;

-- ---------------------------------------------------------------------------
-- Redeem a backup code. Attaches the calling device to the Telegram user's
-- favourite set without any help from Telegram, then burns the code.
-- ---------------------------------------------------------------------------
create or replace function sgbp_redeem_backup_code(
    p_code_hash text,
    p_device_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_code  sgbp_backup_codes%rowtype;
    v_merge jsonb;
    v_total integer;
begin
    select * into v_code
    from sgbp_backup_codes
    where code_hash = p_code_hash
    for update;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'invalid_code');
    end if;

    if v_code.used_at is not null then
        return jsonb_build_object('ok', false, 'error', 'already_used');
    end if;

    insert into sgbp_links (device_id, telegram_id, linked_via)
    values (p_device_id, v_code.telegram_id, 'backup_code')
    on conflict (device_id) do update
        set telegram_id = excluded.telegram_id,
            linked_at   = now(),
            linked_via  = 'backup_code';

    v_merge := sgbp_merge_favourites(p_device_id, v_code.telegram_id);

    update sgbp_backup_codes
    set used_at = now(),
        used_by = p_device_id
    where id = v_code.id;

    select count(*) into v_total
    from sgbp_favourites where telegram_id = v_code.telegram_id;

    return jsonb_build_object(
        'ok', true,
        'telegram_id', v_code.telegram_id,
        'merged', v_merge -> 'merged',
        'total', v_total
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Housekeeping. Call it from the bot scheduler rather than pg_cron so the
-- whole thing keeps working on a free Supabase project.
-- ---------------------------------------------------------------------------
create or replace function sgbp_expire_stale()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_tokens   integer;
    v_requests integer;
begin
    with gone as (
        delete from sgbp_link_tokens
        where expires_at < now() - interval '1 day'
        returning 1
    )
    select count(*) into v_tokens from gone;

    with stale as (
        update sgbp_backup_requests
        set status = 'expired', decided_at = now()
        where status in ('pending', 'notified')
          and expires_at < now()
        returning 1
    )
    select count(*) into v_requests from stale;

    return jsonb_build_object('tokens_purged', v_tokens, 'requests_expired', v_requests);
end;
$$;

-- ============================================================================
-- Lock everything down. No policies means no access for anon or authenticated.
-- ============================================================================
alter table sgbp_devices         enable row level security;
alter table sgbp_telegram_users  enable row level security;
alter table sgbp_links           enable row level security;
alter table sgbp_link_tokens     enable row level security;
alter table sgbp_favourites      enable row level security;
alter table sgbp_backup_requests enable row level security;
alter table sgbp_backup_codes    enable row level security;

revoke all on function sgbp_merge_favourites(uuid, bigint)               from anon, authenticated;
revoke all on function sgbp_consume_link_token(text, bigint, text, text) from anon, authenticated;
revoke all on function sgbp_unlink_device(uuid)                          from anon, authenticated;
revoke all on function sgbp_unlink_all(bigint)                           from anon, authenticated;
revoke all on function sgbp_redeem_backup_code(text, uuid)               from anon, authenticated;
revoke all on function sgbp_expire_stale()                               from anon, authenticated;
