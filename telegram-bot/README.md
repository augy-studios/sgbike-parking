# SG Bike Parking, Telegram bot

Find LTA bicycle parking anywhere in Singapore from a Telegram chat, and keep
the spots you actually use in sync with the web app.

Built on [Telethon](https://docs.telethon.dev). Runs as a long lived process on
a Debian VPS inside tmux. State lives in SQLite locally and in Supabase for
anything the website also needs to see.

For first time setup, including BotFather, read [SETUP.md](SETUP.md).

---

## What it does

**Search by sending a message.** There is no `/find` command. Send an address,
a postal code, an MRT station or a building name and the nearest racks come
back. Share your location instead and you get whatever is closest to where you
are standing.

**Save what you use.** Every result carries a star. Tapping it saves the spot,
tapping it again removes it. The same star does both jobs, in search results
and in the saved list alike, which is why there is no separate remove command.

**Sync with the browser.** Link a browser once and both sides share a single
list. Star something on the site and it is in `/fav`. Star something in chat
and it is on the site when you next open it.

**Survive losing Telegram.** Backup codes, generated on the website with your
approval here, restore your favourites onto a fresh browser without Telegram
being involved at all.

---

## Commands

| Command | What it does |
| --- | --- |
| `/start` | What the bot does, the full command list, and buttons for the web app and the donation link |
| `/fav` | Your saved parking spots, paged, each with a star to remove it |
| `/link` | How to connect a browser so favourites sync both ways |
| `/unlink` | Disconnect every browser, keeping a copy of the list on each side |
| `/settings` | Search radius, sheltered only filter, results per page |
| `/status` | What is linked, what is saved, and how many backup codes remain |

Anything else you send is treated as a place to search near.

---

## How linking works

Linking exists for one reason, which is to sync favourites. There is no account
on the website, no password, no email and no sign up. Nothing is created that
you would have to manage later.

1. Open the web app, tap the sync button in the header, choose **Link Telegram**.
2. The site mints a single use token and sends you to `https://t.me/sgbikepark_bot?start=<token>`.
3. Telegram delivers that token to `/start`, and the bot redeems it.
4. Both favourite sets merge into one, with duplicates dropped by parking code.

A browser identifies itself with a device id and a device secret held in its own
`localStorage`. A Telegram account can own **any number of browsers**, so a
phone, a laptop and a desktop can all show the same list. Each one needs its own
link.

Unlinking never deletes anything. Every browser keeps a copy of the list as it
stood, the chat keeps its copy, and from that point the two stop syncing.

### Backup codes

Backup codes answer the case where Telegram itself is out of reach: a lost
phone, a locked account, a wiped browser.

They are generated on the website, but not without your say so. Asking for a set
raises a request, the bot prompts you here, and only after you tap **Approve**
does the site generate the codes and show them once. That is the two factor
part: possession of an already linked browser is not on its own enough to mint
credentials that outlive Telegram.

Ten codes per batch, each usable once. Generating a new batch invalidates the
old one. Only the SHA-256 hash of a code is ever stored, so a leak of the
database does not hand anyone a working code.

Redeeming a code on the site attaches that browser to the same favourites the
Telegram account owns.

---

## Requirements

- Debian 13, or anything else with Python 3.11 or newer
- A Telegram bot token, plus an API id and hash from my.telegram.org
- An LTA DataMall account key
- A Supabase project with `main-site/migrations/0001_telegram_favourites_sync.sql` applied
- tmux

---

## Install

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip tmux git

git clone https://github.com/<you>/sgbike-parking.git
cd sgbike-parking/telegram-bot

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

cp .env.example .env
chmod 600 .env
nano .env            # fill in every value in the first three sections
```

Then register the command list with Telegram:

```bash
.venv/bin/python tools/set_commands.py
```

---

## Configuration

Everything is read from `.env`. See [.env.example](.env.example) for the
annotated version.

| Variable | Required | What it is |
| --- | --- | --- |
| `TELEGRAM_API_ID` | yes | Application id from my.telegram.org |
| `TELEGRAM_API_HASH` | yes | Application hash from my.telegram.org |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather |
| `SUPABASE_URL` | yes | Project URL, shared with the website |
| `SUPABASE_SERVICE_KEY` | yes | Service role key. Treat it like a password |
| `LTA_ACCOUNT_KEY` | yes | DataMall account key |
| `DONATION_URL` | yes | Where the donate button goes |
| `WEB_APP_URL` | yes | Where the site is deployed. Must match the site that mints link tokens |
| `BOT_USERNAME` | no | Defaults to `sgbikepark_bot` |
| `DB_PATH` | no | Defaults to `./data/bot.db` |
| `SESSION_PATH` | no | Defaults to `./data/bot_session` |
| `DEFAULT_RADIUS_KM` | no | Defaults to `0.5` |
| `DEFAULT_RESULT_LIMIT` | no | Defaults to `5` |
| `LTA_CACHE_TTL_SECONDS` | no | Defaults to six hours |
| `GEOCODE_CACHE_TTL_SECONDS` | no | Defaults to a week |
| `LOG_LEVEL` | no | Defaults to `INFO` |

`WEB_APP_URL` and `LTA_ACCOUNT_KEY` are not optional despite not appearing in
the original brief. The first is needed because `/start` offers a button to the
web app, and the second because the bot queries DataMall directly rather than
going through the site proxy.

---

## Running it in tmux

`run.sh` wraps the tmux handling.

```bash
chmod +x run.sh

./run.sh            # start, or attach if already running
./run.sh status     # is it up
./run.sh logs       # tail the log without attaching
./run.sh restart    # stop, then start
./run.sh stop       # stop
```

Detach from an attached session with **Ctrl+B** then **D**. The bot keeps
running after you disconnect from SSH.

Doing it by hand instead:

```bash
tmux new -s sgbike-bot
cd ~/sgbike-parking/telegram-bot
.venv/bin/python -u bot.py
# Ctrl+B then D to detach
tmux attach -t sgbike-bot
```

### Starting on boot

tmux does not survive a reboot. If you want the bot back automatically, add a
crontab entry:

```bash
crontab -e
```

```cron
@reboot sleep 30 && /home/YOU/sgbike-parking/telegram-bot/run.sh start
```

A systemd unit is the tidier answer if you ever outgrow tmux, but the brief here
is tmux, so this is the lighter path that fits it.

---

## Updating

```bash
cd ~/sgbike-parking
git pull
cd telegram-bot
.venv/bin/pip install -r requirements.txt
./run.sh restart
```

The SQLite database is untouched by a pull, so buttons sent before the update
keep working.

---

## Back up `data/bot.db`

This matters more than it looks. The local database holds the payload behind
every inline button ever sent. Lose it and every button in every old message
stops responding, replying with a note telling the person to send `/start`
again. Favourites are safe either way, because those live in Supabase.

```bash
# Safe to run while the bot is up. SQLite handles the locking.
sqlite3 ~/sgbike-parking/telegram-bot/data/bot.db \
    ".backup '/home/YOU/backups/bot-$(date +%F).db'"
```

---

## How it is put together

```
telegram-bot/
├── bot.py                  Entry point, handler and job wiring, shutdown
├── config.py               Environment loading and validation
├── database.py             SQLite: buttons, jobs, caches, chat state
├── scheduler.py            Durable job loop backed by that database
├── supabase_client.py      PostgREST client for the shared store
├── lta.py                  DataMall lookups, cached, plus distance helpers
├── geocoding.py            OneMap first, Nominatim as a fallback
├── richtext.py             send_rich_message and the persistent button layer
├── handlers/
│   ├── callbacks.py        Token to handler routing for every button
│   ├── common.py           Shared list rendering and paging
│   ├── start.py            /start, and the deep link it doubles as
│   ├── linking.py          /link, /unlink, the token handshake
│   ├── favourites.py       /fav and the star toggle
│   ├── search.py           Free text and shared location searches
│   ├── settings.py         /settings
│   ├── status.py           /status
│   └── backup.py           Approval prompts for backup codes
├── tools/set_commands.py   Push the command list to Telegram
└── run.sh                  tmux wrapper
```

### Buttons that never expire

Telegram allows 64 bytes of callback data on an inline button, nowhere near
enough to carry a parking record. So each button stores its real payload in
SQLite and puts only a short token on the wire, in the form `b:<token>`.

Nothing about a button lives in memory and nothing about it expires. A button
from a message sent last month still resolves today, and still resolves after a
restart, a redeploy, or a move to another machine that brings the database
along. That is the whole reason the payload goes to disk rather than into a
dictionary.

### Scheduling on SQLite

Work that happens later goes through the `jobs` table rather than through
`asyncio.sleep`, so pending work survives a restart. Two recurring jobs run:

- `backup.poll` every five seconds, watching Supabase for approval requests
  raised on the website
- `housekeeping` hourly, expiring stale tokens and trimming the cache

Polling rather than webhooks is deliberate. The VPS needs no inbound port, no
domain and no TLS certificate, and a restart mid flight costs nothing because
the next tick picks the request up again.

### Where data lives

| Data | Where | Why |
| --- | --- | --- |
| Button payloads | SQLite | Local, and the reason buttons outlive restarts |
| Job queue | SQLite | Pending work has to survive a restart |
| LTA and geocoding caches | SQLite | Local, disposable, rebuilt on demand |
| Favourites | Supabase | The website has to see them too |
| Links between browsers and accounts | Supabase | Both halves read it |
| Backup code hashes | Supabase | The website verifies them |
| Search settings | Supabase | Follows the account, not the machine |

---

## Sources

Bicycle parking comes from
[LTA DataMall](https://datamall.lta.gov.sg/content/datamall/en.html), which
publishes locations monthly. This is a directory of where racks are, not live
occupancy.

Addresses resolve through [OneMap](https://www.onemap.gov.sg), Singapore's own
address service, which understands block numbers and six digit postal codes.
[Nominatim](https://nominatim.openstreetmap.org) is the fallback for anything
OneMap does not recognise, called at most once per second as its usage policy
asks.

---

## Troubleshooting

**It exits at startup with a missing variable.** The name is in the message.
Fill it into `.env` and start again.

**No reply to anything.** Check `./run.sh logs`. A bad `TELEGRAM_BOT_TOKEN`
fails at sign in and is obvious in the first few lines.

**Buttons answer with "no longer recognised".** `data/bot.db` was replaced or
lost. Old buttons cannot be recovered, but `/start` produces working ones.

**"That link has expired".** Link tokens last fifteen minutes. Generate a fresh
one from the web app.

**Searches say the parking data is unreachable.** Either `LTA_ACCOUNT_KEY` is
wrong or DataMall is down. Cached areas keep working for six hours.

**The bot ignores plain messages in a group.** That is deliberate. Free text
search runs in direct chats only, so the bot never treats group conversation as
a search. Commands and shared locations still work in groups.

**"Slow down a moment".** Fifteen searches a minute per person. The address
lookup is shared with everyone using the bot, so the limit protects that. It
clears itself, and the message is sent once rather than on every attempt.

---

## Licence

Same as the parent project. See [LICENSE](../LICENSE).
