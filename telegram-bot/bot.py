#!/usr/bin/env python3
"""Entry point.

Run it directly, or through run.sh inside tmux:

    python bot.py

Everything it needs comes from .env. See README.md for the setup, and SETUP.md
for the BotFather side.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys

from telethon import TelegramClient, events

import database
import geocoding
import lta
import supabase_client as sb
from config import (
    LOG_LEVEL,
    SESSION_PATH,
    TELEGRAM_API_HASH,
    TELEGRAM_API_ID,
    TELEGRAM_BOT_TOKEN,
)
from handlers import backup, callbacks, favourites, linking, search, settings, start, status
from scheduler import Scheduler

logging.basicConfig(
    format="%(asctime)s  %(levelname)-8s %(name)s: %(message)s",
    level=getattr(logging, LOG_LEVEL, logging.INFO),
)
# Telethon is chatty at INFO and drowns out everything else.
logging.getLogger("telethon").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

log = logging.getLogger("bot")


# A command may arrive as /fav in a private chat or as /fav@thebot in a group,
# so every pattern tolerates the suffix without naming the bot itself.
def command(name: str, argument: bool = False) -> str:
    tail = r"(?:\s+(\S{1,128}))?" if argument else ""
    return rf"^/{name}(?:@[A-Za-z0-9_]+)?{tail}\s*$"


def register_handlers(client: TelegramClient) -> None:
    client.add_event_handler(
        start.cmd_start, events.NewMessage(pattern=command("start", argument=True))
    )
    client.add_event_handler(linking.cmd_link, events.NewMessage(pattern=command("link")))
    client.add_event_handler(linking.cmd_unlink, events.NewMessage(pattern=command("unlink")))
    client.add_event_handler(favourites.cmd_fav, events.NewMessage(pattern=command("fav")))
    client.add_event_handler(settings.cmd_settings, events.NewMessage(pattern=command("settings")))
    client.add_event_handler(status.cmd_status, events.NewMessage(pattern=command("status")))

    # A shared location is a search for whatever is closest.
    client.add_event_handler(
        search.on_location,
        events.NewMessage(func=lambda e: getattr(e.message, "geo", None) is not None),
    )

    # Anything else typed is read as a place to search near, which is why there
    # is no /find command.
    #
    # Private chats only. In a group with privacy mode turned off the bot sees
    # every message in the room, and treating all of that as a search would
    # geocode ordinary conversation. Commands and shared locations still work
    # in groups, so nothing useful is lost.
    client.add_event_handler(
        search.on_text,
        events.NewMessage(
            func=lambda e: e.is_private
            and bool(e.raw_text)
            and not e.raw_text.startswith("/")
            and getattr(e.message, "geo", None) is None
        ),
    )

    client.add_event_handler(callbacks.dispatch, events.CallbackQuery())

    log.info("Handlers registered")


def register_jobs(client: TelegramClient, scheduler: Scheduler) -> None:
    scheduler.register("backup.poll", backup.make_poll_job(client))
    scheduler.register("housekeeping", backup.make_housekeeping_job())

    # Watching for backup code approval requests raised on the website.
    scheduler.every("backup.poll", backup.POLL_SECONDS, start_after=3)
    # Expiring stale tokens and requests, and trimming the local cache.
    scheduler.every("housekeeping", 3600, start_after=30)

    log.info("Recurring jobs scheduled")


async def main() -> int:
    database.connect()
    log.info("Local database ready")

    client = TelegramClient(str(SESSION_PATH), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    scheduler = Scheduler()

    await client.start(bot_token=TELEGRAM_BOT_TOKEN)

    me = await client.get_me()
    log.info("Signed in as @%s", me.username)

    register_handlers(client)
    register_jobs(client, scheduler)
    scheduler.start()

    stopping = asyncio.Event()

    def request_stop(*_):
        log.info("Shutdown signal received")
        stopping.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_stop)
        except NotImplementedError:
            # Windows does not support add_signal_handler for these.
            signal.signal(sig, request_stop)

    log.info("Running. Press Ctrl+C to stop.")

    disconnected = asyncio.ensure_future(client.disconnected)
    await asyncio.wait(
        [asyncio.ensure_future(stopping.wait()), disconnected],
        return_when=asyncio.FIRST_COMPLETED,
    )

    log.info("Shutting down")
    await scheduler.stop()
    await client.disconnect()
    await sb.close()
    await lta.close()
    await geocoding.close()
    database.close()
    log.info("Stopped cleanly")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
