-- ============================================================================
-- SG Bike Parking Finder
-- Migration 0003: make the favourite unique indexes usable as ON CONFLICT
--                 arbiters
--
-- Why
--   0001 created both favourite indexes partial:
--
--     create unique index sgbp_favourites_telegram_code_key
--         on sgbp_favourites (telegram_id, code) where telegram_id is not null;
--
--   Postgres will only infer a partial index as an ON CONFLICT arbiter if the
--   statement repeats the predicate, and PostgREST's on_conflict parameter
--   emits a column list and nothing else. So every upsert against this table
--   failed with 42P10, there is no unique or exclusion constraint matching the
--   ON CONFLICT specification, which surfaced as a 400 to the caller. In the
--   Telegram bot that was the star button on a search result answering
--   "Something went wrong. Please try again."
--
--   Dropping the predicate loses nothing. A favourite has exactly one owner,
--   enforced by sgbp_favourites_single_owner, so the other column is always
--   null on the rows the predicate used to exclude, and Postgres treats nulls
--   in a unique index as distinct from one another. Device rows still never
--   collide on the Telegram index and vice versa. The only difference is that
--   the index can now be named as an arbiter.
--
--   The API and the bot no longer depend on this: both insert plainly and
--   treat a 23505 as the no-op it is. This migration is what lets an upsert
--   work at all should either want one again.
--
-- Safe to run more than once. Run 0001 and 0002 first.
-- ============================================================================

drop index if exists sgbp_favourites_device_code_key;
drop index if exists sgbp_favourites_telegram_code_key;

create unique index if not exists sgbp_favourites_device_code_key
    on sgbp_favourites (device_id, code);

create unique index if not exists sgbp_favourites_telegram_code_key
    on sgbp_favourites (telegram_id, code);
