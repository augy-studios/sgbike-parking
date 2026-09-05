"""Configuration, loaded once from the environment.

Everything the bot needs comes from environment variables, normally supplied by
a .env file sitting next to this module. See .env.example for the full list.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

load_dotenv(BASE_DIR / ".env")


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        print(
            f"Missing required environment variable {name}.\n"
            f"Copy .env.example to .env and fill it in.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return value


def _optional(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip() or default


# ── Telegram
TELEGRAM_API_ID = int(_required("TELEGRAM_API_ID"))
TELEGRAM_API_HASH = _required("TELEGRAM_API_HASH")
TELEGRAM_BOT_TOKEN = _required("TELEGRAM_BOT_TOKEN")

# Used to build the deep link shown in chat. Without the leading @.
BOT_USERNAME = _optional("BOT_USERNAME", "sgbikepark_bot").lstrip("@")

# ── Supabase, the store the web app and the bot share
SUPABASE_URL = _required("SUPABASE_URL").rstrip("/")
SUPABASE_SERVICE_KEY = _required("SUPABASE_SERVICE_KEY")

# ── LTA DataMall
LTA_ACCOUNT_KEY = _required("LTA_ACCOUNT_KEY")
LTA_ENDPOINT = "https://datamall2.mytransport.sg/ltaodataservice/BicycleParkingv2"

# ── Links surfaced in chat
WEB_APP_URL = _optional("WEB_APP_URL", "https://sgbikeparking.uwuapps.com")
DONATION_URL = _optional("DONATION_URL", "https://donate.stripe.com/28o2akeAr3hv0DK6oo")

# ── Local state
DB_PATH = Path(_optional("DB_PATH", str(BASE_DIR / "data" / "bot.db")))
SESSION_PATH = Path(_optional("SESSION_PATH", str(BASE_DIR / "data" / "bot_session")))

# ── Behaviour
DEFAULT_RADIUS_KM = float(_optional("DEFAULT_RADIUS_KM", "0.5"))
DEFAULT_RESULT_LIMIT = int(_optional("DEFAULT_RESULT_LIMIT", "5"))
LTA_CACHE_TTL_SECONDS = int(_optional("LTA_CACHE_TTL_SECONDS", "21600"))  # six hours
GEOCODE_CACHE_TTL_SECONDS = int(_optional("GEOCODE_CACHE_TTL_SECONDS", "604800"))  # a week
LOG_LEVEL = _optional("LOG_LEVEL", "INFO").upper()

# Nominatim asks that every caller identify itself.
USER_AGENT = _optional(
    "USER_AGENT",
    f"sg-bike-parking-telegram-bot (+{WEB_APP_URL})",
)

# The radius options offered in /settings, in kilometres.
RADIUS_CHOICES = (0.5, 1.0, 1.5, 2.0)

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
