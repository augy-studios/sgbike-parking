"""Async PostgREST client for the shared Supabase project.

This is the only place the bot talks to the store the web app also uses. Every
call goes out with the service key, which bypasses row level security, so this
module must never be handed anything that came straight from a user without
being validated first.

The interesting multi step operations are SQL functions created by
main-site/migrations/0001_telegram_favourites_sync.sql. Calling them through
rpc keeps linking and merging atomic.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from config import SUPABASE_SERVICE_KEY, SUPABASE_URL, USER_AGENT

log = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None

TABLE_USERS = "sgbp_telegram_users"
TABLE_FAVOURITES = "sgbp_favourites"
TABLE_LINKS = "sgbp_links"
TABLE_BACKUP_REQUESTS = "sgbp_backup_requests"
TABLE_BACKUP_CODES = "sgbp_backup_codes"


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            base_url=f"{SUPABASE_URL}/rest/v1",
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            },
            timeout=httpx.Timeout(15.0),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


UNIQUE_VIOLATION = "23505"


class SupabaseError(RuntimeError):
    """A non 2xx answer from PostgREST, carrying enough of it to act on.

    A caller that can recover from one particular failure, such as inserting a
    row that is already there, needs the Postgres SQLSTATE to match against
    rather than a formatted string.
    """

    def __init__(self, status: int, method: str, path: str, body: str) -> None:
        super().__init__(f"Supabase {status} on {method} {path}: {body}")
        self.status = status
        self.body = body
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        self.details = parsed if isinstance(parsed, dict) else {}

    @property
    def code(self) -> str:
        """The SQLSTATE Postgres reported, empty if PostgREST sent none."""
        return str(self.details.get("code") or "")


async def _request(method: str, path: str, **kwargs) -> Any:
    res = await client().request(method, path, **kwargs)
    if res.status_code >= 400:
        raise SupabaseError(res.status_code, method, path, res.text)
    if not res.content:
        return None
    return res.json()


async def select(table: str, params: dict) -> list[dict]:
    return await _request("GET", f"/{table}", params=params) or []


async def insert(table: str, rows: Any, *, upsert: bool = False, on_conflict: str | None = None):
    prefer = ["return=representation"]
    if upsert:
        prefer.append("resolution=merge-duplicates")
    params = {"on_conflict": on_conflict} if on_conflict else None
    return await _request(
        "POST", f"/{table}", json=rows, params=params, headers={"Prefer": ",".join(prefer)}
    )


async def patch(table: str, params: dict, values: dict):
    return await _request(
        "PATCH", f"/{table}", params=params, json=values,
        headers={"Prefer": "return=representation"},
    )


async def delete(table: str, params: dict):
    return await _request(
        "DELETE", f"/{table}", params=params, headers={"Prefer": "return=representation"}
    )


async def rpc(function: str, args: dict) -> Any:
    return await _request("POST", f"/rpc/{function}", json=args)


def utcnow() -> str:
    """A timestamp PostgREST can actually store.

    Values sent through PostgREST are bound as parameters and cast by Postgres,
    so a SQL expression in a JSON body is not evaluated. Postgres does accept
    the bare special string 'now', but not 'now()', which fails with an invalid
    input syntax error. Sending an explicit ISO timestamp sidesteps the whole
    question.
    """
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {"radius": 0.5, "sheltered_only": False, "result_limit": 5}


async def ensure_user(telegram_id: int, username: str | None, first_name: str | None) -> dict:
    """Create the user row on first contact, and keep the name fields current."""
    rows = await insert(
        TABLE_USERS,
        {"telegram_id": telegram_id, "username": username, "first_name": first_name},
        upsert=True,
        on_conflict="telegram_id",
    )
    if rows:
        return rows[0]
    found = await select(TABLE_USERS, {"telegram_id": f"eq.{telegram_id}", "limit": "1"})
    return found[0] if found else {"telegram_id": telegram_id, "settings": dict(DEFAULT_SETTINGS)}


async def get_settings(telegram_id: int) -> dict:
    rows = await select(
        TABLE_USERS, {"telegram_id": f"eq.{telegram_id}", "select": "settings", "limit": "1"}
    )
    settings = dict(DEFAULT_SETTINGS)
    if rows and isinstance(rows[0].get("settings"), dict):
        settings.update(rows[0]["settings"])
    return settings


async def save_settings(telegram_id: int, settings: dict) -> None:
    await patch(
        TABLE_USERS,
        {"telegram_id": f"eq.{telegram_id}"},
        {"settings": settings, "updated_at": utcnow()},
    )


# ---------------------------------------------------------------------------
# Favourites
# ---------------------------------------------------------------------------

FAVOURITE_COLUMNS = (
    "code,description,rack_type,rack_count,sheltered,latitude,longitude,created_at"
)


async def list_favourites(telegram_id: int) -> list[dict]:
    return await select(
        TABLE_FAVOURITES,
        {
            "telegram_id": f"eq.{telegram_id}",
            "select": FAVOURITE_COLUMNS,
            "order": "created_at.asc",
        },
    )


async def is_favourite(telegram_id: int, code: str) -> bool:
    rows = await select(
        TABLE_FAVOURITES,
        {
            "telegram_id": f"eq.{telegram_id}",
            "code": f"eq.{code}",
            "select": "code",
            "limit": "1",
        },
    )
    return bool(rows)


async def add_favourite(telegram_id: int, spot: dict) -> None:
    """Save one spot. Saving something already saved is a no-op.

    This deliberately does not ask PostgREST for an upsert. The unique index
    behind it was created partial, `where telegram_id is not null`, and Postgres
    only infers a partial index as an ON CONFLICT arbiter when the statement
    repeats that predicate, which the on_conflict parameter cannot express. The
    upsert therefore came back as a 400 and every tap of the star failed.
    Inserting plainly and treating the duplicate as success asks nothing of the
    index shape, so it holds whether or not 0003 has been run.
    """
    try:
        await insert(
            TABLE_FAVOURITES,
            {
                "telegram_id": telegram_id,
                "device_id": None,
                "code": spot["code"],
                "description": spot.get("description") or spot["code"],
                "rack_type": spot.get("rack_type"),
                "rack_count": spot.get("rack_count"),
                "sheltered": bool(spot.get("sheltered")),
                "latitude": spot.get("latitude"),
                "longitude": spot.get("longitude"),
            },
        )
    except SupabaseError as err:
        # Two taps racing each other, or a stale button. Already saved is the
        # outcome the caller wanted either way.
        if err.code != UNIQUE_VIOLATION:
            raise


async def remove_favourite(telegram_id: int, code: str) -> int:
    gone = await delete(
        TABLE_FAVOURITES, {"telegram_id": f"eq.{telegram_id}", "code": f"eq.{code}"}
    )
    return len(gone or [])


async def count_favourites(telegram_id: int) -> int:
    rows = await select(
        TABLE_FAVOURITES, {"telegram_id": f"eq.{telegram_id}", "select": "code"}
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Linking
# ---------------------------------------------------------------------------

async def consume_link_token(
    token: str, telegram_id: int, username: str | None, first_name: str | None
) -> dict:
    """Redeem a start payload. Creates the link and merges both favourite sets."""
    return await rpc(
        "sgbp_consume_link_token",
        {
            "p_token": token,
            "p_telegram_id": telegram_id,
            "p_username": username,
            "p_first_name": first_name,
        },
    )


async def unlink_all(telegram_id: int) -> dict:
    return await rpc("sgbp_unlink_all", {"p_telegram_id": telegram_id})


async def count_linked_devices(telegram_id: int) -> int:
    rows = await select(
        TABLE_LINKS, {"telegram_id": f"eq.{telegram_id}", "select": "device_id"}
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Backup codes
# ---------------------------------------------------------------------------

async def pending_backup_requests() -> list[dict]:
    """Requests the web app has raised that nobody has been asked about yet."""
    return await select(
        TABLE_BACKUP_REQUESTS,
        {
            "status": "eq.pending",
            "select": "id,telegram_id,device_id,created_at,expires_at",
            "order": "created_at.asc",
            "limit": "20",
        },
    )


async def mark_backup_request(
    request_id: str, status: str, *, chat_id: int | None = None, message_id: int | None = None
) -> list[dict]:
    values: dict[str, Any] = {"status": status}
    if status in {"approved", "declined"}:
        values["decided_at"] = utcnow()
    if status == "notified":
        values["notified_at"] = utcnow()
    if chat_id is not None:
        values["chat_id"] = chat_id
    if message_id is not None:
        values["message_id"] = message_id
    return await patch(TABLE_BACKUP_REQUESTS, {"id": f"eq.{request_id}"}, values) or []


async def get_backup_request(request_id: str) -> dict | None:
    rows = await select(
        TABLE_BACKUP_REQUESTS,
        {"id": f"eq.{request_id}", "select": "id,telegram_id,status,expires_at", "limit": "1"},
    )
    return rows[0] if rows else None


async def count_unused_backup_codes(telegram_id: int) -> int:
    rows = await select(
        TABLE_BACKUP_CODES,
        {"telegram_id": f"eq.{telegram_id}", "used_at": "is.null", "select": "id"},
    )
    return len(rows)


# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------

async def expire_stale() -> dict:
    return await rpc("sgbp_expire_stale", {})
