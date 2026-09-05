"""The /start command, and the deep link it doubles as.

Telegram sends the start payload from t.me/<bot>?start=<token> to this same
command, so /start has two jobs: introduce the bot when it arrives bare, and
finish a link when it arrives carrying a token.
"""

from __future__ import annotations

from config import DONATION_URL, WEB_APP_URL
from handlers import callbacks
from handlers.common import user_from_event
from handlers.linking import complete_link
from richtext import ActionButton, UrlButton, edit_rich_message, send_rich_message

ABOUT = (
    "Find LTA bicycle parking anywhere in Singapore, straight from chat.\n\n"
    "<b>Search by sending a message</b>\n"
    "Send an address, a postal code or a place name and you get the nearest "
    "racks back. Share your location instead and you get whatever is closest "
    "to where you are standing.\n\n"
    "<b>Keep the ones you use</b>\n"
    "Tap the star on any result to save it. Saved spots live under /fav and "
    "sync with the web app once the two are linked.\n\n"
    "<b>Commands</b>\n"
    "/fav lists everything you have saved\n"
    "/link connects a browser so favourites sync both ways\n"
    "/unlink disconnects every browser and keeps both copies\n"
    "/settings sets your search radius, shelter filter and result count\n"
    "/status shows what is linked and what is saved\n"
    "/start shows this message again"
)

FOOTER = "Locations come from LTA DataMall and are updated monthly. This is a directory, not live availability."


def start_buttons(telegram_id: int):
    return [
        [UrlButton("Open the web app", WEB_APP_URL)],
        [ActionButton("My favourites", "fav.list", {"page": 0})],
        [UrlButton("Buy Augy a coffee", DONATION_URL)],
    ]


async def cmd_start(event) -> None:
    client = event.client
    telegram_id, _ = await user_from_event(event)

    # A start payload means the web app sent this person here to finish a link.
    match = event.pattern_match
    payload = (match.group(1) or "").strip() if match else ""

    if payload:
        await complete_link(client, event, payload)
        return

    await send_rich_message(
        client,
        event.chat_id,
        title="Bicycle parking in Singapore",
        body=ABOUT,
        footer=FOOTER,
        buttons=start_buttons(telegram_id),
        user_id=telegram_id,
    )


@callbacks.on("start.show")
async def cb_start(event, payload, action) -> None:
    await edit_rich_message(
        event,
        title="Bicycle parking in Singapore",
        body=ABOUT,
        footer=FOOTER,
        buttons=start_buttons(event.sender_id),
        user_id=event.sender_id,
    )
    await event.answer()


@callbacks.on("noop")
async def cb_noop(event, payload, action) -> None:
    """The page indicator is a button because Telegram has no plain label."""
    await event.answer()
