"""/status: what is linked, what is saved, and what recovery you have left."""

from __future__ import annotations

import supabase_client as sb
from config import WEB_APP_URL
from handlers.common import user_from_event
from richtext import ActionButton, UrlButton, send_rich_message


async def cmd_status(event) -> None:
    telegram_id, settings = await user_from_event(event)

    favourites = await sb.count_favourites(telegram_id)
    devices = await sb.count_linked_devices(telegram_id)
    codes = await sb.count_unused_backup_codes(telegram_id)

    link_line = (
        f"<b>{devices}</b> browser{'' if devices == 1 else 's'} sharing this list"
        if devices
        else "No browser is linked yet"
    )

    if not devices:
        recovery = "Link a browser first, then you can create backup codes there."
    elif codes:
        recovery = f"<b>{codes}</b> unused backup code{'' if codes == 1 else 's'}"
    else:
        recovery = (
            "No backup codes yet. Create a set in the web app so you can reach "
            "these favourites even without Telegram."
        )

    body = (
        f"<b>Favourites</b>\n{favourites} saved\n\n"
        f"<b>Sync</b>\n{link_line}\n\n"
        f"<b>Recovery</b>\n{recovery}\n\n"
        f"<b>Search</b>\n{float(settings.get('radius') or 0.5):g}km radius, "
        f"{int(settings.get('result_limit') or 5)} per page, "
        f"sheltered filter {'on' if settings.get('sheltered_only') else 'off'}"
    )

    buttons = [[ActionButton("My favourites", "fav.list", {"page": 0})]]
    if not devices:
        buttons.append([UrlButton("Open the web app to link", WEB_APP_URL)])

    await send_rich_message(
        event.client,
        event.chat_id,
        title="Your sync status",
        body=body,
        buttons=buttons,
        user_id=telegram_id,
    )
