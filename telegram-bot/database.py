"""SQLite state for the bot.

Three things live here.

Button actions
    Telegram allows only 64 bytes of callback data on an inline button, which
    is not enough to carry a parking record around. So every button stores its
    real payload in this database and puts a short token on the wire. Because
    the rows are never deleted, a button keeps working forever, including after
    a restart, a redeploy, or a move to a different machine that carries the
    database along with it.

Jobs
    A small durable scheduler. Rows are picked up by a poller in scheduler.py.
    Recurring work is expressed with an interval, one shot work without one.
    Pending jobs survive a restart, which is the whole reason for not using
    asyncio.sleep for this.

Caches
    Rounded LTA lookups and geocoding results, so repeated searches in the same
    area do not hammer either upstream.

SQLite calls here are synchronous. They are all single row or single index
lookups against a local file, so they finish in well under a millisecond and do
not meaningfully block the event loop. WAL mode plus a lock keeps concurrent
handlers honest.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from config import DB_PATH

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS button_actions (
    token        TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    user_id      INTEGER,
    chat_id      INTEGER,
    message_id   INTEGER,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS button_actions_message_idx
    ON button_actions (chat_id, message_id);

CREATE TABLE IF NOT EXISTS jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    payload          TEXT NOT NULL DEFAULT '{}',
    run_at           TEXT NOT NULL,
    interval_seconds INTEGER,
    unique_key       TEXT UNIQUE,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (status, run_at);

CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expiry_idx ON cache (expires_at);

CREATE TABLE IF NOT EXISTS chat_state (
    user_id    INTEGER PRIMARY KEY,
    state      TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_backup_requests (
    request_id TEXT PRIMARY KEY,
    notified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket       TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start REAL    NOT NULL,
    warned       INTEGER NOT NULL DEFAULT 0
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    """Open the database and apply the schema. Safe to call more than once."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.executescript(SCHEMA)
            _conn.commit()
        return _conn


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    with _lock:
        conn = connect()
        cur = conn.execute(sql, tuple(params))
        conn.commit()
        return cur


def query_one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    with _lock:
        return connect().execute(sql, tuple(params)).fetchone()


def query_all(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, tuple(params)).fetchall()


# ---------------------------------------------------------------------------
# Button actions
# ---------------------------------------------------------------------------

def register_button(
    kind: str,
    payload: dict | None = None,
    *,
    user_id: int | None = None,
    chat_id: int | None = None,
) -> str:
    """Store a button payload and return the token that goes on the wire."""
    token = secrets.token_urlsafe(8)
    execute(
        """
        INSERT INTO button_actions (token, kind, payload, user_id, chat_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (token, kind, json.dumps(payload or {}), user_id, chat_id, now_iso()),
    )
    return token


def resolve_button(token: str) -> dict | None:
    """Look a token back up. Returns None when the token is unknown."""
    row = query_one("SELECT * FROM button_actions WHERE token = ?", (token,))
    if row is None:
        return None
    execute(
        "UPDATE button_actions SET last_used_at = ? WHERE token = ?",
        (now_iso(), token),
    )
    return {
        "token": row["token"],
        "kind": row["kind"],
        "payload": json.loads(row["payload"]),
        "user_id": row["user_id"],
        "chat_id": row["chat_id"],
        "message_id": row["message_id"],
    }


def attach_buttons_to_message(tokens: list[str], chat_id: int, message_id: int) -> None:
    """Record where a set of buttons ended up, so they can be re-rendered."""
    if not tokens:
        return
    placeholders = ",".join("?" for _ in tokens)
    execute(
        f"UPDATE button_actions SET chat_id = ?, message_id = ? WHERE token IN ({placeholders})",
        (chat_id, message_id, *tokens),
    )


def update_button_payload(token: str, payload: dict) -> None:
    execute(
        "UPDATE button_actions SET payload = ? WHERE token = ?",
        (json.dumps(payload), token),
    )


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def schedule_job(
    kind: str,
    *,
    run_in_seconds: float = 0,
    payload: dict | None = None,
    interval_seconds: int | None = None,
    unique_key: str | None = None,
) -> int:
    """Queue a job. A unique_key makes the call idempotent across restarts."""
    run_at = (datetime.now(timezone.utc) + timedelta(seconds=run_in_seconds)).isoformat()
    stamp = now_iso()

    if unique_key:
        existing = query_one("SELECT id FROM jobs WHERE unique_key = ?", (unique_key,))
        if existing:
            return int(existing["id"])

    cur = execute(
        """
        INSERT INTO jobs (kind, payload, run_at, interval_seconds, unique_key,
                          created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            kind,
            json.dumps(payload or {}),
            run_at,
            interval_seconds,
            unique_key,
            stamp,
            stamp,
        ),
    )
    return int(cur.lastrowid)


def due_jobs(limit: int = 20) -> list[sqlite3.Row]:
    return query_all(
        """
        SELECT * FROM jobs
        WHERE status = 'pending' AND run_at <= ?
        ORDER BY run_at ASC
        LIMIT ?
        """,
        (now_iso(), limit),
    )


def mark_job_done(job: sqlite3.Row) -> None:
    """Reschedule a recurring job, or retire a one shot one."""
    if job["interval_seconds"]:
        next_run = (
            datetime.now(timezone.utc) + timedelta(seconds=int(job["interval_seconds"]))
        ).isoformat()
        execute(
            "UPDATE jobs SET run_at = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?",
            (next_run, now_iso(), job["id"]),
        )
    else:
        execute(
            "UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?",
            (now_iso(), job["id"]),
        )


def mark_job_failed(job: sqlite3.Row, error: str, *, max_attempts: int = 5) -> None:
    """Back off on failure, and give up on a one shot job that keeps failing."""
    attempts = int(job["attempts"]) + 1

    if job["interval_seconds"]:
        delay = int(job["interval_seconds"])
    else:
        delay = min(300, 2 ** attempts)

    if not job["interval_seconds"] and attempts >= max_attempts:
        execute(
            "UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
            (attempts, error[:500], now_iso(), job["id"]),
        )
        return

    next_run = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()
    execute(
        "UPDATE jobs SET run_at = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
        (next_run, attempts, error[:500], now_iso(), job["id"]),
    )


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def cache_get(key: str) -> Any | None:
    row = query_one("SELECT value, expires_at FROM cache WHERE key = ?", (key,))
    if row is None:
        return None
    if row["expires_at"] < time.time():
        execute("DELETE FROM cache WHERE key = ?", (key,))
        return None
    return json.loads(row["value"])


def cache_set(key: str, value: Any, ttl_seconds: int) -> None:
    execute(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        (key, json.dumps(value), time.time() + ttl_seconds),
    )


def cache_purge_expired() -> int:
    return execute("DELETE FROM cache WHERE expires_at < ?", (time.time(),)).rowcount


# ---------------------------------------------------------------------------
# Per user conversation state, used by /settings and the search prompt
# ---------------------------------------------------------------------------

def set_state(user_id: int, state: str, payload: dict | None = None) -> None:
    execute(
        "INSERT INTO chat_state (user_id, state, payload, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, "
        "payload = excluded.payload, updated_at = excluded.updated_at",
        (user_id, state, json.dumps(payload or {}), now_iso()),
    )


def get_state(user_id: int) -> tuple[str, dict] | None:
    row = query_one("SELECT state, payload FROM chat_state WHERE user_id = ?", (user_id,))
    if row is None:
        return None
    return row["state"], json.loads(row["payload"])


def clear_state(user_id: int) -> None:
    execute("DELETE FROM chat_state WHERE user_id = ?", (user_id,))


# ---------------------------------------------------------------------------
# Backup request bookkeeping, so a prompt is never sent twice
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Per user rate limiting
# ---------------------------------------------------------------------------

def rate_limit_hit(bucket: str, limit: int, window_seconds: int) -> dict:
    """Count one hit and report whether it is allowed.

    Geocoding is the expensive part of a search, and the Nominatim lock is
    process wide, so without this one person sending messages in a loop would
    serialize address lookups for everybody else.

    `warn` is true only on the first rejection in a window, which is what stops
    the bot answering a flood with a flood of its own.
    """
    with _lock:
        conn = connect()
        now = time.time()
        row = conn.execute(
            "SELECT count, window_start, warned FROM rate_limits WHERE bucket = ?",
            (bucket,),
        ).fetchone()

        if row is None or now - row["window_start"] >= window_seconds:
            conn.execute(
                "INSERT INTO rate_limits (bucket, count, window_start, warned) "
                "VALUES (?, 1, ?, 0) "
                "ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = ?, warned = 0",
                (bucket, now, now),
            )
            conn.commit()
            return {"allowed": True, "warn": False, "retry_after": 0}

        count = int(row["count"]) + 1
        allowed = count <= limit
        warn = not allowed and not row["warned"]

        conn.execute(
            "UPDATE rate_limits SET count = ?, warned = ? WHERE bucket = ?",
            (count, 1 if (row["warned"] or warn) else 0, bucket),
        )
        conn.commit()

        return {
            "allowed": allowed,
            "warn": warn,
            "retry_after": max(0, int(window_seconds - (now - row["window_start"]))),
        }


def mark_request_notified(request_id: str) -> bool:
    """Returns True the first time a request id is seen, False afterwards."""
    try:
        execute(
            "INSERT INTO seen_backup_requests (request_id, notified_at) VALUES (?, ?)",
            (request_id, now_iso()),
        )
        return True
    except sqlite3.IntegrityError:
        return False
