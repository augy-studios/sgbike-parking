"""Searching, by typed text or by a shared location.

There is no /find command on purpose. Anything typed that is not a command is
treated as a place to look near, and a shared location is treated the same way.
That keeps the common case down to sending one message.
"""

from __future__ import annotations

import logging

import database
import geocoding
import lta
import supabase_client as sb
from config import RADIUS_CHOICES, WEB_APP_URL
from handlers import callbacks
from handlers.common import pager_row, paginate, render_spot_list, spot_buttons, user_from_event
from richtext import ActionButton, UrlButton, edit_rich_message, esc, send_rich_message, truncate

log = logging.getLogger(__name__)

# Generous for a person, pointless for a script. A search costs a geocode plus
# possibly an LTA call, and the geocoder is shared across everyone using the bot.
SEARCHES_PER_MINUTE = 15


async def within_rate_limit(event, telegram_id: int) -> bool:
    """Check the allowance, and say so once rather than on every message."""
    verdict = database.rate_limit_hit(f"search:{telegram_id}", SEARCHES_PER_MINUTE, 60)
    if verdict["allowed"]:
        return True

    if verdict["warn"]:
        await send_rich_message(
            event.client,
            event.chat_id,
            title="Slow down a moment",
            body=(
                "That is a lot of searches in one minute. Give it about "
                f"{verdict['retry_after']} seconds and carry on.\n\n"
                "The address lookup is shared with everyone else using this, "
                "which is why there is a limit at all."
            ),
            user_id=telegram_id,
        )
    return False


async def build_search_view(telegram_id: int, context: dict, settings: dict):
    """Assemble the title, body and buttons for one page of results.

    The results themselves come back through the SQLite cache in almost every
    case, so paging does not mean another call to DataMall.
    """
    lat = context["lat"]
    lng = context["lng"]
    radius = float(context.get("radius") or settings.get("radius") or 0.5)
    label = context.get("label") or "your location"
    page = int(context.get("page") or 0)
    sheltered_only = bool(context.get("sheltered_only", settings.get("sheltered_only")))

    spots = await lta.nearby(lat, lng, radius)
    spots = lta.apply_filters(spots, sheltered_only=sheltered_only)

    if not spots:
        filters_note = " that are sheltered" if sheltered_only else ""
        body = (
            f"Nothing{filters_note} within {radius:g}km of {esc(label)}.\n\n"
            "Try a wider radius below, or send a different address."
        )
        buttons = [
            [
                ActionButton(
                    f"{choice:g}km",
                    "search.radius",
                    {**context, "radius": choice, "page": 0},
                )
                for choice in RADIUS_CHOICES
                if choice != radius
            ],
            [UrlButton("Open the web app", WEB_APP_URL)],
        ]
        return "No parking found", body, buttons

    page_size = int(settings.get("result_limit") or 5)
    items, page, total_pages = paginate(spots, page, page_size)
    context = {**context, "page": page, "radius": radius, "sheltered_only": sheltered_only}

    title = f"{len(spots)} spot{'' if len(spots) == 1 else 's'} near {label}"
    body = render_spot_list(items, start_index=page * page_size + 1)

    buttons = await spot_buttons(items, telegram_id, context={**context, "kind": "search"})

    nav = pager_row(context, page, total_pages, "search.page")
    if nav:
        buttons.append(nav)

    # Offer the radii that are not already in use.
    radius_row = [
        ActionButton(f"{choice:g}km", "search.radius", {**context, "radius": choice, "page": 0})
        for choice in RADIUS_CHOICES
        if choice != radius
    ]
    if radius_row:
        buttons.append(radius_row)

    return title, truncate(body), buttons


async def respond_with_results(event, telegram_id: int, context: dict, settings: dict) -> None:
    title, body, buttons = await build_search_view(telegram_id, context, settings)
    await send_rich_message(
        event.client,
        event.chat_id,
        title=title,
        body=body,
        footer=f"Searching within {context.get('radius', settings.get('radius', 0.5)):g}km. Tap a star to save a spot.",
        buttons=buttons,
        user_id=telegram_id,
    )


async def on_text(event) -> None:
    """Any non command message is read as a place to search near."""
    query = (event.raw_text or "").strip()
    if not query or query.startswith("/"):
        return

    client = event.client
    telegram_id, settings = await user_from_event(event)

    if not await within_rate_limit(event, telegram_id):
        return

    async with client.action(event.chat_id, "typing"):
        place = await geocoding.lookup(query)

        if place is None:
            await send_rich_message(
                client,
                event.chat_id,
                title="Could not find that",
                body=(
                    f"Nothing in Singapore matched <b>{esc(query)}</b>.\n\n"
                    "Try a postal code, a block and street, or an MRT station "
                    "name. You can also share your location and skip the "
                    "typing altogether."
                ),
                user_id=telegram_id,
            )
            return

        try:
            await respond_with_results(
                event,
                telegram_id,
                {
                    "lat": place["lat"],
                    "lng": place["lng"],
                    "label": place["name"],
                    "radius": settings.get("radius", 0.5),
                    "page": 0,
                },
                settings,
            )
        except Exception:  # noqa: BLE001
            log.exception("Search failed for %r", query)
            await send_rich_message(
                client,
                event.chat_id,
                title="Could not reach the parking data",
                body=(
                    "LTA DataMall did not answer just now. Please try again in "
                    "a moment. The web app may still have cached results."
                ),
                buttons=[[UrlButton("Open the web app", WEB_APP_URL)]],
                user_id=telegram_id,
            )


async def on_location(event) -> None:
    """A shared location skips geocoding entirely."""
    geo = event.message.geo
    if geo is None:
        return

    client = event.client
    telegram_id, settings = await user_from_event(event)

    if not await within_rate_limit(event, telegram_id):
        return

    async with client.action(event.chat_id, "typing"):
        try:
            await respond_with_results(
                event,
                telegram_id,
                {
                    "lat": geo.lat,
                    "lng": geo.long,
                    "label": "your location",
                    "radius": settings.get("radius", 0.5),
                    "page": 0,
                },
                settings,
            )
        except Exception:  # noqa: BLE001
            log.exception("Location search failed")
            await send_rich_message(
                client,
                event.chat_id,
                title="Could not reach the parking data",
                body="LTA DataMall did not answer just now. Please try again shortly.",
                user_id=telegram_id,
            )


async def _rerender(event, payload) -> None:
    telegram_id = event.sender_id
    settings = await sb.get_settings(telegram_id)
    title, body, buttons = await build_search_view(telegram_id, payload, settings)

    await edit_rich_message(
        event,
        title=title,
        body=body,
        footer=f"Searching within {payload.get('radius', 0.5):g}km. Tap a star to save a spot.",
        buttons=buttons,
        user_id=telegram_id,
    )


@callbacks.on("search.page")
async def cb_search_page(event, payload, action) -> None:
    await _rerender(event, payload)
    await event.answer()


@callbacks.on("search.radius")
async def cb_search_radius(event, payload, action) -> None:
    await _rerender(event, payload)
    await event.answer(f"Now searching within {payload.get('radius', 0.5):g}km")
