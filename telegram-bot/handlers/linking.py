"""Account linking: /link, /unlink, and the deep link handshake.

What linking actually does
    It ties one browser session to one Telegram account so a single set of
    favourites is visible from both. There is no account, no password and no
    sign up. A Telegram account may own any number of browser sessions, which
    is what lets a phone, a laptop and a work machine all show the same list.

The handshake
    The web app mints a single use token and opens t.me/<bot>?start=<token>.
    Telegram delivers that token to /start, and the bot hands it straight to
    the sgbp_consume_link_token function, which validates it, creates the link
    and merges both favourite sets in one transaction. Duplicates are dropped
    by parking code, so nothing is saved twice.
"""

from __future__ import annotations

import logging

import supabase_client as sb
from config import WEB_APP_URL
from handlers import callbacks
from handlers.common import user_from_event
from richtext import (
    ActionButton,
    Steps,
    Table,
    UrlButton,
    compose,
    edit_rich_message,
    send_rich_message,
)

log = logging.getLogger(__name__)

TOKEN_ERRORS = {
    "unknown_token": (
        "That link is not one this chat recognises. Open the web app, tap the "
        "sync button and start the link again."
    ),
    "already_used": (
        "That link has already been used. Each one works a single time. Generate "
        "a fresh link from the web app if you want to connect another browser."
    ),
    "expired": (
        "That link has expired. Links stay valid for fifteen minutes. Generate a "
        "new one from the web app and tap it a little sooner."
    ),
}


def _browsers(count: int) -> str:
    return f"{count} browser{'' if count == 1 else 's'}"


def build_linked_view(result: dict) -> tuple[dict, list]:
    """The report after a successful merge."""
    merged = int(result.get("merged") or 0)
    duplicates = int(result.get("duplicates") or 0)
    total = int(result.get("total") or 0)
    devices = int(result.get("devices") or 0)

    rows = []
    if merged:
        rows.append(["Brought over from that browser", merged])
    if duplicates:
        rows.append(["Already saved here, so skipped", duplicates])
    rows.append(["Total favourites now", total])
    rows.append(["Browsers connected", devices])

    rich = compose(
        "Linked",
        "Your browser and this chat now share one set of favourites. "
        "Anything you star in either place shows up in the other.",
        Table(["Count"], rows),
        footer="Link as many browsers as you like. Each one needs its own link.",
    )
    buttons = [
        [ActionButton("View favourites", "fav.list", {"page": 0})],
        [UrlButton("Open the web app", WEB_APP_URL)],
    ]
    return rich, buttons


async def complete_link(client, event, token: str) -> None:
    """Redeem a start payload and report what the merge did."""
    sender = await event.get_sender()
    telegram_id = event.sender_id

    try:
        result = await sb.consume_link_token(
            token,
            telegram_id,
            getattr(sender, "username", None),
            getattr(sender, "first_name", None),
        )
    except Exception:  # noqa: BLE001
        log.exception("Link token redemption failed")
        await send_rich_message(
            client,
            event.chat_id,
            compose(
                "Linking did not go through",
                "Something went wrong while connecting your browser. Nothing was "
                "changed. Please try the link again in a moment.",
            ),
            user_id=telegram_id,
        )
        return

    if not result or not result.get("ok"):
        reason = (result or {}).get("error", "unknown_token")
        await send_rich_message(
            client,
            event.chat_id,
            compose(
                "That link did not work",
                TOKEN_ERRORS.get(reason, TOKEN_ERRORS["unknown_token"]),
            ),
            [[UrlButton("Open the web app", WEB_APP_URL)]],
            user_id=telegram_id,
        )
        return

    rich, buttons = build_linked_view(result)
    await send_rich_message(client, event.chat_id, rich, buttons, user_id=telegram_id)


def build_link_view(devices: int) -> tuple[dict, list]:
    """/link explains where the link is started, because the site mints it."""
    if devices:
        rich = compose(
            "Sync your favourites",
            f"You already have {_browsers(devices)} connected.",
            "To add another one, open the web app on that device, tap the sync "
            "button in the header and choose Link Telegram. It will send you "
            "back here to confirm.",
        )
    else:
        rich = compose(
            "Sync your favourites",
            "Linking is started from the web app so it knows which browser to "
            "connect.",
            Steps(
                [
                    "Open the web app on the device you want to sync.",
                    "Tap the sync button in the header.",
                    "Choose Link Telegram.",
                ]
            ),
            "You will be sent back here to finish. Favourites already saved in "
            "that browser and any saved here are merged into one list, with "
            "duplicates left out.",
        )

    return rich, [[UrlButton("Open the web app", WEB_APP_URL)]]


async def cmd_link(event) -> None:
    client = event.client
    telegram_id, _ = await user_from_event(event)

    devices = await sb.count_linked_devices(telegram_id)

    rich, buttons = build_link_view(devices)
    await send_rich_message(client, event.chat_id, rich, buttons, user_id=telegram_id)


async def cmd_unlink(event) -> None:
    """/unlink asks first, because it touches every connected browser."""
    client = event.client
    telegram_id, _ = await user_from_event(event)

    devices = await sb.count_linked_devices(telegram_id)

    if not devices:
        await send_rich_message(
            client,
            event.chat_id,
            compose(
                "Nothing to unlink",
                "No browser is connected to this chat at the moment. Your "
                "favourites here are unaffected.",
            ),
            user_id=telegram_id,
        )
        return

    await send_rich_message(
        client,
        event.chat_id,
        compose(
            "Remove the link?",
            f"This disconnects {_browsers(devices)} from this chat.",
            "Nothing is deleted. Each browser keeps its own copy of the current "
            "list, and your favourites stay here too. From then on the two "
            "stop syncing and drift apart independently.",
        ),
        [
            [
                ActionButton("Yes, unlink", "unlink.confirm", {}),
                ActionButton("Keep it linked", "unlink.cancel", {}),
            ]
        ],
        user_id=telegram_id,
    )


@callbacks.on("unlink.confirm")
async def cb_unlink_confirm(event, payload, action) -> None:
    result = await sb.unlink_all(event.sender_id)
    devices = int((result or {}).get("devices") or 0)

    await edit_rich_message(
        event.client,
        event,
        compose(
            "Unlinked",
            f"Disconnected {_browsers(devices)}. Each one kept a copy of the "
            "list, and your favourites here are untouched.",
            "You can link again at any time from the web app.",
        ),
        [[UrlButton("Open the web app", WEB_APP_URL)]],
        user_id=event.sender_id,
    )
    await event.answer("Unlinked")


@callbacks.on("unlink.cancel")
async def cb_unlink_cancel(event, payload, action) -> None:
    await edit_rich_message(
        event.client,
        event,
        compose(
            "Still linked",
            "Nothing changed. Your browsers and this chat carry on sharing one list.",
        ),
        user_id=event.sender_id,
    )
    await event.answer("Left as it was")
