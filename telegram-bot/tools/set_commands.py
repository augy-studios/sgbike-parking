#!/usr/bin/env python3
"""Push the command list to Telegram without going through BotFather.

BotFather can do this by hand, and SETUP.md walks through that. This script is
the same thing without the typing, and it is the safer option because the text
here is the single source of truth.

    .venv/bin/python tools/set_commands.py

The descriptions deliberately avoid naming the bot, so the menu reads as a list
of actions rather than an advertisement.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telethon import TelegramClient  # noqa: E402
from telethon.tl.functions.bots import SetBotCommandsRequest  # noqa: E402
from telethon.tl.types import BotCommand, BotCommandScopeDefault  # noqa: E402

from config import (  # noqa: E402
    SESSION_PATH,
    TELEGRAM_API_HASH,
    TELEGRAM_API_ID,
    TELEGRAM_BOT_TOKEN,
)

COMMANDS = [
    ("start", "What this does, and the buttons to get going"),
    ("fav", "Your saved parking spots"),
    ("link", "Sync favourites with a browser"),
    ("unlink", "Stop syncing and keep a copy in both places"),
    ("settings", "Search radius, shelter filter, results per page"),
    ("status", "What is linked and what is saved"),
]


async def main() -> int:
    client = TelegramClient(str(SESSION_PATH), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.start(bot_token=TELEGRAM_BOT_TOKEN)

    await client(
        SetBotCommandsRequest(
            scope=BotCommandScopeDefault(),
            lang_code="",
            commands=[BotCommand(command=name, description=text) for name, text in COMMANDS],
        )
    )

    print(f"Set {len(COMMANDS)} commands:")
    for name, text in COMMANDS:
        print(f"  /{name:<10} {text}")

    await client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
