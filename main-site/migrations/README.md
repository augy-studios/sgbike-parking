# Supabase migrations

SQL for the favourites sync that the web app and the Telegram bot share.
Table prefix is `sgbp_`.

## Running a migration

Paste the file into the Supabase SQL editor and run it, or use the CLI:

```bash
supabase db execute --file migrations/0001_telegram_favourites_sync.sql
```

Files are numbered and are meant to run in order. They are written to be safe
to run twice, so re-running one does not break anything.

| File | What it does |
| --- | --- |
| `0001_telegram_favourites_sync.sql` | Devices, Telegram users, links, link tokens, favourites, backup codes, and the atomic link and merge functions. |
| `0002_rate_limits_and_longer_codes.sql` | A durable rate limit counter for the serverless endpoints, cleanup of spent windows and abandoned devices. Pairs with twelve character backup codes in the API. |
| `0003_favourite_upsert_arbiters.sql` | Replaces the partial unique indexes on `sgbp_favourites` with plain ones, so `on_conflict` can name them. Postgres refuses to infer a partial index as an arbiter, which made every favourite upsert fail with a 400. |

## Security

Every table has row level security enabled and no policies at all, which denies
the `anon` and `authenticated` roles completely. Only the service role reaches
these tables, and it does so from two places:

- the Vercel serverless functions in `main-site/api/`
- the Telegram bot on the VPS

`SUPABASE_SERVICE_KEY` must never be shipped to a browser. There is no Supabase
client in any file under `main-site/js/`, and it must stay that way.

## Environment variables

Set both of these in the Vercel project settings and in the bot `.env`:

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
```
