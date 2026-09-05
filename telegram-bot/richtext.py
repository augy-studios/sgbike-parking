"""Message composition and the persistent button layer.

send_rich_message is the single way this bot talks. Telethon has no method by
that name, so it is defined here: a small wrapper that lays out a title, a
body, an optional footer, and a set of inline buttons, sends it as HTML, and
records every button in SQLite so it keeps working after a restart.

Why buttons go through the database
    Telegram carries at most 64 bytes of callback data on a button, which is
    not enough for a parking record. So the payload is stored locally and only
    a short token travels on the wire, in the form b:<token>. The rows are
    never expired, which is what makes a button from last month still respond
    today.

House style
    No em dashes anywhere in user facing copy. Sentences are rewritten rather
    than punctuated around, so nothing reads as though a dash was removed.
"""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from telethon import Button

import database

log = logging.getLogger(__name__)

CALLBACK_PREFIX = "b:"


# ---------------------------------------------------------------------------
# Button specs
# ---------------------------------------------------------------------------

@dataclass
class ActionButton:
    """An inline button whose payload is kept in SQLite."""

    text: str
    kind: str
    payload: dict = field(default_factory=dict)


@dataclass
class UrlButton:
    """A plain link button. Nothing to persist, Telegram handles it."""

    text: str
    url: str


ButtonSpec = ActionButton | UrlButton
ButtonRows = Sequence[Sequence[ButtonSpec]]


def build_buttons(
    rows: ButtonRows | None, *, user_id: int | None = None, chat_id: int | None = None
) -> tuple[list[list[Any]] | None, list[str]]:
    """Turn button specs into Telethon buttons, registering the action ones."""
    if not rows:
        return None, []

    built: list[list[Any]] = []
    tokens: list[str] = []

    for row in rows:
        built_row = []
        for spec in row:
            if isinstance(spec, UrlButton):
                built_row.append(Button.url(spec.text, spec.url))
                continue

            token = database.register_button(
                spec.kind, spec.payload, user_id=user_id, chat_id=chat_id
            )
            tokens.append(token)
            built_row.append(
                Button.inline(spec.text, data=f"{CALLBACK_PREFIX}{token}".encode())
            )
        if built_row:
            built.append(built_row)

    return (built or None), tokens


# ---------------------------------------------------------------------------
# Text composition
# ---------------------------------------------------------------------------

def esc(value: Any) -> str:
    """Escape anything that came from a user or from an upstream API."""
    return html.escape(str(value), quote=False)


def compose(title: str | None, body: str, footer: str | None = None) -> str:
    parts: list[str] = []
    if title:
        parts.append(f"<b>{title}</b>")
    if body:
        parts.append(body)
    if footer:
        parts.append(f"<i>{footer}</i>")
    return "\n\n".join(parts)


def bullet_list(lines: Iterable[str]) -> str:
    return "\n".join(f"• {line}" for line in lines)


# ---------------------------------------------------------------------------
# Sending
# ---------------------------------------------------------------------------

async def send_rich_message(
    client,
    entity,
    *,
    title: str | None = None,
    body: str = "",
    footer: str | None = None,
    buttons: ButtonRows | None = None,
    reply_to: int | None = None,
    link_preview: bool = False,
    user_id: int | None = None,
):
    """Send a formatted message and remember its buttons.

    Returns the sent message so callers can keep hold of the id.
    """
    chat_id = getattr(entity, "id", entity) if not isinstance(entity, int) else entity
    telethon_buttons, tokens = build_buttons(buttons, user_id=user_id, chat_id=chat_id)

    message = await client.send_message(
        entity,
        compose(title, body, footer),
        parse_mode="html",
        buttons=telethon_buttons,
        reply_to=reply_to,
        link_preview=link_preview,
    )

    if tokens:
        database.attach_buttons_to_message(tokens, message.chat_id, message.id)

    return message


async def edit_rich_message(
    event_or_message,
    *,
    title: str | None = None,
    body: str = "",
    footer: str | None = None,
    buttons: ButtonRows | None = None,
    link_preview: bool = False,
    user_id: int | None = None,
):
    """Rewrite a message in place, replacing whatever buttons it carried.

    Used by callback handlers so a tap updates the message that was tapped
    rather than piling another one into the chat.
    """
    telethon_buttons, tokens = build_buttons(buttons, user_id=user_id)

    message = await event_or_message.edit(
        compose(title, body, footer),
        parse_mode="html",
        buttons=telethon_buttons,
        link_preview=link_preview,
    )

    # An edit on a CallbackQuery returns the updated message, but not always.
    if tokens and message is not None:
        chat_id = getattr(message, "chat_id", None)
        message_id = getattr(message, "id", None)
        if chat_id and message_id:
            database.attach_buttons_to_message(tokens, chat_id, message_id)

    return message


# ---------------------------------------------------------------------------
# Shared renderers
# ---------------------------------------------------------------------------

def maps_url(spot: dict) -> str:
    lat, lng = spot.get("latitude"), spot.get("longitude")
    return f"https://maps.google.com/?daddr={lat},{lng}&travelmode=bicycling"


def truncate(text: str, limit: int = 3800) -> str:
    """Telegram caps a message at 4096 characters. Leave room for markup."""
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"
