"""Saved parking spots: /fav, and the star that saves and unsaves them.

There is no separate command to remove a favourite. The same star that saved a
spot removes it, in the results list and in the favourites list alike, which is
why every row carries its current state in the button label.
"""

from __future__ import annotations

import logging

import supabase_client as sb
from config import WEB_APP_URL
from handlers import callbacks
from handlers.common import (
    NAV_OPEN,
    pager_row,
    paginate,
    render_spot_list,
    spot_buttons,
    user_from_event,
)
from richtext import UrlButton, edit_rich_message, send_rich_message, truncate

log = logging.getLogger(__name__)

EMPTY_BODY = (
    "You have not saved anything yet.\n\n"
    "Send an address or share your location, then tap the star next to any "
    "result. Saved spots turn up here and in the web app once the two are "
    "linked."
)


def _to_spot(row: dict) -> dict:
    """A stored favourite in the same shape a search result uses."""
    return {
        "code": row["code"],
        "description": row.get("description") or row["code"],
        "rack_type": row.get("rack_type") or "Racks",
        "rack_count": row.get("rack_count") or 0,
        "sheltered": bool(row.get("sheltered")),
        "latitude": row.get("latitude"),
        "longitude": row.get("longitude"),
    }


async def build_fav_view(
    telegram_id: int, page: int, settings: dict, *, nav_open: str | None = None
):
    rows = await sb.list_favourites(telegram_id)

    if not rows:
        return (
            "No favourites yet",
            EMPTY_BODY,
            [[UrlButton("Open the web app", WEB_APP_URL)]],
        )

    spots = [_to_spot(row) for row in rows]
    page_size = int(settings.get("result_limit") or 5)
    items, page, total_pages = paginate(spots, page, page_size)

    title = f"{len(spots)} saved spot{'' if len(spots) == 1 else 's'}"
    body = render_spot_list(items, start_index=page * page_size + 1)

    context = {"kind": "fav", "page": page}
    if nav_open:
        context[NAV_OPEN] = nav_open
    buttons = await spot_buttons(items, telegram_id, context=context)

    nav = pager_row({"kind": "fav"}, page, total_pages, "fav.list")
    if nav:
        buttons.append(nav)

    buttons.append([UrlButton("Open the web app", WEB_APP_URL)])

    return title, truncate(body), buttons


async def cmd_fav(event) -> None:
    client = event.client
    telegram_id, settings = await user_from_event(event)

    title, body, buttons = await build_fav_view(telegram_id, 0, settings)
    devices = await sb.count_linked_devices(telegram_id)

    footer = (
        "Tap a star to remove a spot. Syncing with "
        f"{devices} browser{'' if devices == 1 else 's'}."
        if devices
        else "Tap a star to remove a spot. Use /link to sync these with the web app."
    )

    await send_rich_message(
        client,
        event.chat_id,
        title=title,
        body=body,
        footer=footer,
        buttons=buttons,
        user_id=telegram_id,
    )


@callbacks.on("fav.list")
async def cb_fav_list(event, payload, action) -> None:
    telegram_id = event.sender_id
    settings = await sb.get_settings(telegram_id)
    page = int(payload.get("page") or 0)

    title, body, buttons = await build_fav_view(telegram_id, page, settings)

    await edit_rich_message(
        event,
        title=title,
        body=body,
        footer="Tap a star to remove a spot.",
        buttons=buttons,
        user_id=telegram_id,
    )
    await event.answer()


@callbacks.on("fav.toggle")
async def cb_fav_toggle(event, payload, action) -> None:
    """Save or unsave, then repaint whichever list the star was sitting in."""
    telegram_id = event.sender_id
    spot = payload.get("spot") or {}
    context = payload.get("context") or {}
    code = spot.get("code")

    if not code:
        await event.answer("That spot is missing its parking code.", alert=True)
        return

    saved_now = await sb.is_favourite(telegram_id, code)

    if saved_now:
        await sb.remove_favourite(telegram_id, code)
        note = f"Removed {code}"
    else:
        await sb.add_favourite(telegram_id, spot)
        note = f"Saved {code}"

    try:
        await repaint(event, telegram_id, context)
    except Exception:  # noqa: BLE001
        # The favourite itself is already saved. A failed repaint is cosmetic,
        # so tell the person what happened rather than raising at them.
        log.exception("Could not repaint after toggling %s", code)

    await event.answer(note)


@callbacks.on("nav.open")
async def cb_nav_open(event, payload, action) -> None:
    """Swap one spot's Navigate button for its row of map app links."""
    telegram_id = event.sender_id
    code = payload.get("code")
    context = {**(payload.get("context") or {}), NAV_OPEN: code}

    if not code:
        await event.answer("That spot is missing its parking code.", alert=True)
        return

    await repaint(event, telegram_id, context)
    await event.answer()


async def repaint(event, telegram_id: int, context: dict) -> None:
    """Redraw whichever list a button was sitting in, search or favourites.

    The context on every spot button says which kind of list it came from and
    carries enough to rebuild that list from scratch.
    """
    settings = await sb.get_settings(telegram_id)

    if context.get("kind") == "search":
        # Imported here rather than at module scope to keep the two handler
        # modules from importing each other in a cycle.
        from handlers.search import build_search_view

        title, body, buttons = await build_search_view(telegram_id, context, settings)
        footer = f"Searching within {context.get('radius', 0.5):g}km. Tap a star to save a spot."
    else:
        title, body, buttons = await build_fav_view(
            telegram_id,
            int(context.get("page") or 0),
            settings,
            nav_open=context.get(NAV_OPEN),
        )
        footer = "Tap a star to remove a spot."

    await edit_rich_message(
        event, title=title, body=body, footer=footer, buttons=buttons, user_id=telegram_id
    )
