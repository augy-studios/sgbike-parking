"""Callback routing for the persistent inline buttons.

Every inline button in this bot carries nothing but b:<token>. The token is
looked up in SQLite, which gives back the kind and the full payload, and the
kind selects a handler registered here.

The point of the indirection is longevity. A button pressed months after it was
sent still resolves, because nothing about it lives in memory and nothing about
it expires. The only way a button stops working is if the database is lost.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable

import database
from richtext import CALLBACK_PREFIX

log = logging.getLogger(__name__)

CallbackHandler = Callable[..., Awaitable[None]]

_registry: dict[str, CallbackHandler] = {}


def on(kind: str):
    """Register a handler for one button kind."""

    def decorator(func: CallbackHandler) -> CallbackHandler:
        _registry[kind] = func
        return func

    return decorator


async def dispatch(event) -> None:
    """Resolve the token on a tapped button and hand it to its handler."""
    raw = (event.data or b"").decode("utf-8", "ignore")

    if not raw.startswith(CALLBACK_PREFIX):
        await event.answer("That button is not something this chat knows about.")
        return

    action = database.resolve_button(raw[len(CALLBACK_PREFIX):])

    if action is None:
        # The only realistic cause is a database that was replaced or wiped.
        await event.answer(
            "This button is no longer recognised. Send /start to get a fresh one.",
            alert=True,
        )
        return

    # A button minted for one person should not be usable by another.
    owner = action.get("user_id")
    if owner is not None and event.sender_id != owner:
        await event.answer("This button belongs to someone else.", alert=True)
        return

    handler = _registry.get(action["kind"])
    if handler is None:
        log.warning("No callback handler for kind %r", action["kind"])
        await event.answer("That action is not available in this version.", alert=True)
        return

    try:
        await handler(event, action["payload"], action)
    except Exception:  # noqa: BLE001 - never leave the spinner turning
        log.exception("Callback %s failed", action["kind"])
        await event.answer("Something went wrong. Please try again.", alert=True)
