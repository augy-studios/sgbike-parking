"""Message composition and the persistent button layer.

Every structured message this bot sends is a genuine Telegram Rich Message:
a heading, paragraphs, subheadings, bullet lists and pipe tables that a
current client renders natively. The raw MTProto calls live in reply.py. This
module sits on top of them and does two things:

Composition
    A message is described once, as a title plus a list of blocks, and
    compose() renders it twice: as Telegram's Rich Markdown dialect and as
    plain text. The plain text is the fallback that fills the request's
    required message field, so an old client or a rejected payload still
    shows the same information. Building both from one description is what
    stops the two drifting apart.

Buttons through the database
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

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Sequence
from urllib.parse import quote

from telethon import Button

import database
import reply

log = logging.getLogger(__name__)

CALLBACK_PREFIX = "b:"


# ---------------------------------------------------------------------------
# Escaping
# ---------------------------------------------------------------------------

_MD_SPECIAL = re.compile(r"([\\*_~`|\[\]#>=])")


def escape_md(text: Any) -> str:
    """Escape user/data text for Telegram's Rich Markdown dialect."""
    return _MD_SPECIAL.sub(r"\\\1", str(text))


def escape_cell(text: Any) -> str:
    """Escape for a GFM table cell; also flattens newlines so the row stays intact."""
    return escape_md(str(text).replace("\n", " "))


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------
#
# Each block renders itself both ways. Anything a person or an upstream API
# supplied is escaped on the markdown side, and literal markup is only ever
# written here, never at a call site.

@dataclass
class Para:
    """A paragraph.

    The text is plain prose and is escaped for the markdown rendering. When a
    paragraph needs emphasis inside it, pass the markdown rendering explicitly
    as md, escaping the dynamic parts yourself.
    """

    text: str
    md: str | None = None

    def markdown(self) -> str:
        return self.md if self.md is not None else escape_md(self.text)

    def plain(self) -> str:
        return self.text


@dataclass
class Subheading:
    text: str

    def markdown(self) -> str:
        return f"## {escape_md(self.text)}"

    def plain(self) -> str:
        return self.text


@dataclass
class Section:
    """A subheading with one paragraph directly under it."""

    title: str
    text: str

    def markdown(self) -> str:
        return f"## {escape_md(self.title)}\n{escape_md(self.text)}"

    def plain(self) -> str:
        return f"{self.title}\n{self.text}"


@dataclass
class Bullets:
    items: Sequence[str]

    def markdown(self) -> str:
        return "\n".join(f"- {escape_md(item)}" for item in self.items)

    def plain(self) -> str:
        return "\n".join(f"• {item}" for item in self.items)


@dataclass
class Steps:
    """A numbered list."""

    items: Sequence[str]

    def markdown(self) -> str:
        return "\n".join(f"{n}. {escape_md(item)}" for n, item in enumerate(self.items, 1))

    def plain(self) -> str:
        return "\n".join(f"{n}. {item}" for n, item in enumerate(self.items, 1))


@dataclass
class Table:
    """A pipe table with a label column.

    Every row starts with its label, then carries one cell per header. The
    corner cell above the labels is left empty, and labels are set in bold so
    a row can be picked out at a glance.
    """

    headers: Sequence[str]
    rows: Sequence[Sequence[Any]]

    def markdown(self) -> str:
        lines = [
            "| " + " | ".join(["", *(escape_cell(h) for h in self.headers)]) + " |",
            "| " + " | ".join(["---"] * (len(self.headers) + 1)) + " |",
        ]
        for label, *values in self.rows:
            cells = [f"**{escape_cell(label)}**", *(escape_cell(v) for v in values)]
            lines.append("| " + " | ".join(cells) + " |")
        return "\n".join(lines)

    def plain(self) -> str:
        lines = []
        for label, *values in self.rows:
            if len(self.headers) == 1:
                lines.append(f"{label}: {values[0]}")
            else:
                pairs = ", ".join(f"{h} {v}" for h, v in zip(self.headers, values))
                lines.append(f"{label}: {pairs}")
        return "\n".join(lines)


Block = Para | Subheading | Section | Bullets | Steps | Table


def compose(title: str | None, *blocks: Block | str, footer: str | None = None) -> dict:
    """Render a title, some blocks and an optional footer both ways.

    Returns the message contract reply.py expects:
    {"markdown": ..., "fallback": ...}. A bare string is a paragraph.
    """
    markdown: list[str] = []
    plain: list[str] = []

    if title:
        markdown.append(f"# {escape_md(title)}")
        plain.append(title)

    for block in blocks:
        if isinstance(block, str):
            block = Para(block)
        markdown.append(block.markdown())
        plain.append(block.plain())

    if footer:
        markdown.append(f"_{escape_md(footer)}_")
        plain.append(footer)

    return {"markdown": "\n\n".join(markdown), "fallback": "\n\n".join(plain)}


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
# Sending
# ---------------------------------------------------------------------------

async def send_rich_message(
    client,
    entity,
    rich: dict,
    buttons: ButtonRows | None = None,
    *,
    user_id: int | None = None,
) -> int | None:
    """Send a composed message and remember its buttons.

    Returns the id of the message that went out, or None if Telegram did not
    say, so callers that need to edit it later can keep hold of it.
    """
    chat_id = entity if isinstance(entity, int) else getattr(entity, "id", None)
    telethon_buttons, tokens = build_buttons(buttons, user_id=user_id, chat_id=chat_id)

    result = await reply.send_rich_message(client, entity, rich, telethon_buttons)
    message_id = reply.sent_message_id(result)

    if tokens and chat_id is not None and message_id is not None:
        database.attach_buttons_to_message(tokens, chat_id, message_id)

    return message_id


async def edit_rich_message(
    client,
    event,
    rich: dict,
    buttons: ButtonRows | None = None,
    *,
    user_id: int | None = None,
) -> None:
    """Rewrite the message a button was tapped on, replacing its buttons.

    Used by callback handlers so a tap updates the message that was tapped
    rather than piling another one into the chat. With no buttons the old
    keyboard is removed.
    """
    telethon_buttons, tokens = build_buttons(buttons, user_id=user_id)

    await reply.edit_rich_message(client, event, rich, telethon_buttons)

    # An inline-mode message has no chat and message id to record against.
    if tokens and isinstance(event.query.msg_id, int):
        database.attach_buttons_to_message(tokens, event.chat_id, event.query.msg_id)


# ---------------------------------------------------------------------------
# Shared renderers
# ---------------------------------------------------------------------------

# Telegram only accepts http and https on a URL button, so each of these is the
# app's universal link rather than its custom scheme. On a phone with the app
# installed the link opens the app; otherwise it falls back to the website.

def maps_url(spot: dict) -> str:
    lat, lng = spot.get("latitude"), spot.get("longitude")
    return f"https://maps.google.com/?daddr={lat},{lng}&travelmode=bicycling"


def citymapper_url(spot: dict) -> str:
    lat, lng = spot.get("latitude"), spot.get("longitude")
    name = quote(str(spot.get("code") or "Bicycle parking"))
    return f"https://citymapper.com/directions?endcoord={lat}%2C{lng}&endname={name}"


def waze_url(spot: dict) -> str:
    lat, lng = spot.get("latitude"), spot.get("longitude")
    return f"https://waze.com/ul?ll={lat}%2C{lng}&navigate=yes"
