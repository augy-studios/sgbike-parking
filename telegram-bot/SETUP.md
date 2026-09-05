# Setup

Everything needed to take this from an empty VPS to a working bot. Follow it in
order, because later steps depend on values produced by earlier ones.

There are five parts.

1. [Create the bot with BotFather](#1-create-the-bot-with-botfather)
2. [Get a Telegram API id and hash](#2-get-a-telegram-api-id-and-hash)
3. [Set up Supabase](#3-set-up-supabase)
4. [Get an LTA DataMall key](#4-get-an-lta-datamall-key)
5. [Install and run on the VPS](#5-install-and-run-on-the-vps)

Then [configure the website](#6-configure-the-website) and
[verify the whole thing](#7-verify-it).

---

## 1. Create the bot with BotFather

Open [@BotFather](https://t.me/BotFather) in Telegram.

### Create it

```
/newbot
```

BotFather asks for two things.

- **Name**: `SG Bike Parking Finder`. This is the display name at the top of
  the chat, and it can be changed later.
- **Username**: `sgbikepark_bot`. It has to end in `bot` and it is permanent.

BotFather replies with a token that looks like
`8123456789:AAF0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

**That token is a password.** Anyone holding it controls the bot completely.
Put it straight into `.env` as `TELEGRAM_BOT_TOKEN` and never paste it anywhere
else. If it leaks, run `/revoke` in BotFather and replace it.

### Set the about text

This is the short blurb on the bot's profile card, before anyone starts a chat.
It has a **120 character limit**.

```
/setabouttext
```

Pick the bot, then send:

```
Find LTA bicycle parking anywhere in Singapore. Save the spots you use and sync them with the web app.
```

### Set the description

This is the longer text shown on the empty chat screen, above the Start button.
It has a **512 character limit**.

```
/setdescription
```

Pick the bot, then send:

```
Find bicycle parking anywhere in Singapore, straight from chat.

Send an address, a postal code or a place name to see the nearest racks. Share your location instead and get whatever is closest to you.

Tap the star on any result to save it. Link a browser and your saved spots sync both ways with the web app, so the list is the same wherever you open it.

Locations come from LTA DataMall and update monthly. This is a directory of where racks are, not live availability.

Tap Start to begin.
```

### Set the command list

```
/setcommands
```

Pick the bot, then send this block exactly. One command per line, no leading
slash, with the description after a hyphen. No command names the bot, which
keeps the menu reading as a list of actions.

```
start - What this does, and the buttons to get going
fav - Your saved parking spots
link - Sync favourites with a browser
unlink - Stop syncing and keep a copy in both places
settings - Search radius, shelter filter, results per page
status - What is linked and what is saved
```

There is deliberately **no `/help` and no `/about`**. Everything either would
have said lives in `/start`, so there is one place to look rather than three
that drift apart.

You can skip this step entirely and run the script instead, which sets the same
list from the same source of truth:

```bash
.venv/bin/python tools/set_commands.py
```

### Set the profile picture

```
/setuserpic
```

Pick the bot and upload `main-site/SBPH-512.png` from this repository.

### Privacy mode

Leave privacy mode **on**, which is the default. Nothing here needs it off.

Free text search is deliberately limited to direct chats. In a group the bot
answers commands and shared locations, and ignores ordinary conversation, so
turning privacy mode off would gain you nothing and would only mean the bot
receives messages it has no use for.

### Deep linking

Nothing to configure. Deep links work on every bot by default. The website sends
people to `https://t.me/sgbikepark_bot?start=<token>` and Telegram passes the
token through to `/start`, which the bot handles.

If you chose a different username, set `BOT_USERNAME` in the bot's `.env` and
`TELEGRAM_BOT_USERNAME` in the Vercel project, or the generated links point at
the wrong bot.

---

## 2. Get a Telegram API id and hash

Telethon signs in as an application, not just as a bot token, so it needs these
two on top of the token.

1. Go to [my.telegram.org](https://my.telegram.org) and log in with your phone
   number. The confirmation code arrives in Telegram, not by SMS.
2. Open **API development tools**.
3. Fill in the form. App title `sgbike-parking-bot`, short name
   `sgbikeparking`, platform **Other**. The URL and description can be left
   blank.
4. Copy **App api_id** and **App api_hash**.

These go into `.env` as `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. They belong
to your Telegram account, so treat them as private.

---

## 3. Set up Supabase

Supabase is the store the website and the bot share. It is what makes a
favourite starred on a phone show up in chat.

1. Create a project at [supabase.com](https://supabase.com). The free tier is
   ample. Pick Singapore as the region.
2. Open the **SQL Editor**, click **New query**, and run each file in
   `main-site/migrations/` in order, one at a time:
   - `0001_telegram_favourites_sync.sql`
   - `0002_rate_limits_and_longer_codes.sql`
3. Go to **Project Settings**, then **API**, and copy:
   - **Project URL** into `SUPABASE_URL`
   - **service_role** key into `SUPABASE_SERVICE_KEY`

### About the service key

The migration turns on row level security for every table and creates no
policies, which denies the `anon` and `authenticated` roles outright. Only the
service role can read or write, and it is used from exactly two places: the
Vercel serverless functions, and the bot on the VPS.

The service key must never reach a browser. There is no Supabase client
anywhere under `main-site/js/`, and there must never be one.

### Check it applied

Run this in the SQL editor. It should return eight rows.

```sql
select table_name
from information_schema.tables
where table_schema = 'public' and table_name like 'sgbp_%'
order by table_name;
```

Expected: `sgbp_backup_codes`, `sgbp_backup_requests`, `sgbp_devices`,
`sgbp_favourites`, `sgbp_link_tokens`, `sgbp_links`, `sgbp_rate_limits`,
`sgbp_telegram_users`.

---

## 4. Get an LTA DataMall key

1. Request an account key at
   [datamall.lta.gov.sg](https://datamall.lta.gov.sg/content/datamall/en.html).
   Approval usually arrives by email within a day or two.
2. Put it into `.env` as `LTA_ACCOUNT_KEY`.

This is the same key the website already uses for its serverless proxy. The bot
queries DataMall directly rather than going through the site, so the key lives
in both places.

---

## 5. Install and run on the VPS

On Debian 13:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip tmux git sqlite3

git clone https://github.com/<you>/sgbike-parking.git
cd sgbike-parking/telegram-bot

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

cp .env.example .env
chmod 600 .env
nano .env
```

Fill in every value from the previous steps, then register the commands and
start it:

```bash
.venv/bin/python tools/set_commands.py

chmod +x run.sh
./run.sh
```

You should see something close to this:

```
Local database ready
Signed in as @sgbikepark_bot
Handlers registered
Recurring jobs scheduled
Scheduler started with handlers: backup.poll, housekeeping
Running. Press Ctrl+C to stop.
```

Detach with **Ctrl+B** then **D**. The bot keeps running after you log out.

To bring it back after a reboot, add a crontab entry with `crontab -e`:

```cron
@reboot sleep 30 && /home/YOU/sgbike-parking/telegram-bot/run.sh start
```

---

## 6. Configure the website

The site needs its own copy of the Supabase credentials, because the serverless
functions talk to the same tables.

In the Vercel project, under **Settings**, then **Environment Variables**, add:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | The same project URL |
| `SUPABASE_SERVICE_KEY` | The same service role key |
| `TELEGRAM_BOT_USERNAME` | `sgbikepark_bot` |

`LTA_ACCOUNT_KEY` should already be there for the existing parking proxy.

Redeploy so the new variables take effect.

---

## 7. Verify it

Work through these in order. Each one exercises a different half of the system.

**The bot answers**

Open the bot in Telegram and press Start. You should get the introduction with
buttons for the web app, favourites and the donation link.

**Search works**

Send `238801`, or any Singapore postal code. You should get a list of nearby
racks with a star on each row. This proves the DataMall key and the geocoder.

**Favourites persist**

Tap a star. The row should redraw with a filled star. Send `/fav` and the spot
should be listed. This proves the Supabase connection.

**Buttons outlive a restart**

Run `./run.sh restart`, then go back and tap a star on the older message. It
should still respond. This is what the SQLite button registry is for.

**Linking merges both sides**

Open the web app in a browser, star a different spot, then use the sync button
to link. Back in chat you should get a confirmation naming how many favourites
came across and how many were skipped as duplicates. Send `/fav` and both spots
should be there.

**Backup codes need approval**

In the web app, open sync and choose **Generate codes**. Within a few seconds
the bot should ask you to approve. Tap **Approve** and ten codes should appear
in the browser. Tap **Decline** on a second attempt and no codes should be
produced.

**Recovery works without Telegram**

Open the site in a private window, enter one of those codes under the recovery
box, and your favourites should appear. Codes work once, so the same code
should be rejected the second time.

---

## Changing things later

**The display name, about text or description**: BotFather, using the same
commands as above. Changes are live immediately.

**The command list**: edit `COMMANDS` in `tools/set_commands.py` and run it
again, or use `/setcommands`. Keep it in step with the `/start` text in
`handlers/start.py`, since that is what people actually read.

**The username**: it cannot be changed. You would need a new bot, a new token,
and a new `BOT_USERNAME` plus `TELEGRAM_BOT_USERNAME`. Existing links would
break.

**The token**: `/revoke` in BotFather, then update `.env` and restart. Nothing
else is affected, because favourites are keyed on Telegram user ids rather than
on the token.
