-- ============================================================================
-- SG Bike Parking Finder
-- Migration 0002: rate limiting, orphan device cleanup, longer backup codes
--
-- Why
--   0001 shipped the sync feature with no throttling anywhere. Three gaps
--   worth closing before this is public:
--
--   1. Backup code redemption looked codes up by hash across every user at
--      once, so a brute force attempt was not guessing one person's code, it
--      was guessing anyone's. With N users holding ten codes each, the search
--      space effectively divides by 10N. Codes also carried only about 40 bits.
--   2. POST /api/device was unauthenticated and unlimited, so a loop could
--      fill the project and take sync down for everyone.
--   3. Nothing ever cleaned up devices that registered and then did nothing.
--
--   Serverless functions cannot hold a counter between invocations, so the
--   limiter has to live in the database. sgbp_rate_limit_hit is a single
--   atomic upsert, which is what keeps two concurrent requests from both
--   seeing themselves as under the limit.
--
-- Safe to run more than once. Run 0001 first.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Fixed window counters. One row per bucket, where a bucket is something like
-- redeem:ip:1.2.3.4 or device:ip:1.2.3.4.
-- ---------------------------------------------------------------------------
create table if not exists sgbp_rate_limits (
    bucket       text primary key,
    count        integer     not null default 0,
    window_start timestamptz not null default now()
);
create index if not exists sgbp_rate_limits_window_idx
    on sgbp_rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Count a hit and say whether it is allowed.
--
-- The whole thing is one INSERT ... ON CONFLICT so the read, the window roll
-- and the increment cannot be split by a concurrent caller. Returning the
-- updated row means the decision is made on the value that was actually
-- written rather than one read a moment earlier.
-- ---------------------------------------------------------------------------
create or replace function sgbp_rate_limit_hit(
    p_bucket         text,
    p_limit          integer,
    p_window_seconds integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row    sgbp_rate_limits%rowtype;
    v_now    timestamptz := now();
    v_window interval := make_interval(secs => p_window_seconds);
begin
    insert into sgbp_rate_limits as r (bucket, count, window_start)
    values (p_bucket, 1, v_now)
    on conflict (bucket) do update
        set count = case
                        when r.window_start < v_now - v_window then 1
                        else r.count + 1
                    end,
            window_start = case
                        when r.window_start < v_now - v_window then v_now
                        else r.window_start
                    end
    returning * into v_row;

    return jsonb_build_object(
        'allowed', v_row.count <= p_limit,
        'count', v_row.count,
        'limit', p_limit,
        'retry_after', greatest(
            0,
            ceil(extract(epoch from (v_row.window_start + v_window) - v_now))::integer
        )
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Replaces the 0001 version. Now also purges spent rate limit windows and
-- devices that registered but never did anything.
--
-- A device is only ever created lazily, on the first favourite or the first
-- link attempt, so a week old device with no favourites and no link is the
-- residue of an abandoned attempt. Deleting one is safe: the browser holding
-- those credentials gets a 401 on its next call, and js/sync.js responds by
-- discarding them and registering again, keeping its local favourites.
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
    v_buckets  integer;
    v_devices  integer;
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

    -- A window older than a day cannot still be limiting anything.
    with spent as (
        delete from sgbp_rate_limits
        where window_start < now() - interval '1 day'
        returning 1
    )
    select count(*) into v_buckets from spent;

    with orphans as (
        delete from sgbp_devices d
        where d.created_at < now() - interval '7 days'
          and not exists (select 1 from sgbp_favourites f where f.device_id = d.id)
          and not exists (select 1 from sgbp_links l where l.device_id = d.id)
        returning 1
    )
    select count(*) into v_devices from orphans;

    return jsonb_build_object(
        'tokens_purged', v_tokens,
        'requests_expired', v_requests,
        'rate_windows_purged', v_buckets,
        'orphan_devices_purged', v_devices
    );
end;
$$;

alter table sgbp_rate_limits enable row level security;

revoke all on function sgbp_rate_limit_hit(text, integer, integer) from anon, authenticated;
revoke all on function sgbp_expire_stale()                          from anon, authenticated;
