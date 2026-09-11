"""Rendering helpers shared by the search and favourites handlers.

Both produce the same kind of output: a list of parking spots with a star to
save or unsave each one, a navigation link, and paging when there is more than
one screenful. Keeping that in one place is what makes a result from a search
and a result from /fav behave identically.
"""

from __future__ import annotations

import lta
import supabase_client as sb
from richtext import ActionButton, UrlButton, citymapper_url, esc, maps_url, waze_url

STAR_SAVED = "★"
STAR_EMPTY = "☆"

PAGE_SIZE_MAX = 8

# The context key that names the spot whose Navigate button has been opened
# into its row of map apps. It rides along in the context so a star toggle on
# the same message keeps the row open, and it is dropped when paging away.
NAV_OPEN = "nav_open"


def star_label(code: str, saved: bool) -> str:
    """Button text for a favourite toggle. Kept short so it fits on a phone."""
    mark = STAR_SAVED if saved else STAR_EMPTY
    label = code if len(code) <= 22 else code[:21] + "…"
    return f"{mark} {label}"


def render_spot_list(spots: list[dict], *, start_index: int = 1) -> str:
    """The numbered body of a results message."""
    blocks = []
    for offset, spot in enumerate(spots):
        facts = [
            spot.get("rack_type") or "Racks",
            f"{spot.get('rack_count') or 0} lots",
            "sheltered" if spot.get("sheltered") else "not sheltered",
        ]
        if spot.get("distance_km") is not None:
            facts.append(f"{lta.format_distance(spot['distance_km'])} away")

        blocks.append(
            f"<b>{start_index + offset}. {esc(spot['code'])}</b>\n"
            f"<i>{esc(' · '.join(facts))}</i>"
        )
    return "\n\n".join(blocks)


async def spot_buttons(
    spots: list[dict],
    telegram_id: int,
    *,
    context: dict,
) -> list[list]:
    """One row per spot: a favourite toggle and a Navigate button.

    Tapping Navigate does not open a map straight away. It swaps itself for a
    row of three links, one per map app, so the person picks the one they
    actually have installed. Only one spot's row is open at a time.
    """
    saved_codes = {f["code"] for f in await sb.list_favourites(telegram_id)}
    nav_open = context.get(NAV_OPEN)

    rows: list[list] = []
    for spot in spots:
        saved = spot["code"] in saved_codes
        row = [
            ActionButton(
                star_label(spot["code"], saved),
                "fav.toggle",
                {"spot": spot, "context": context},
            )
        ]
        has_coords = spot.get("latitude") is not None and spot.get("longitude") is not None

        if has_coords and spot["code"] != nav_open:
            row.append(
                ActionButton("Navigate", "nav.open", {"code": spot["code"], "context": context})
            )
        rows.append(row)

        if has_coords and spot["code"] == nav_open:
            # Three labels side by side already fill a phone screen, so the
            # links sit on their own row directly under the star.
            rows.append(
                [
                    UrlButton("Google Maps", maps_url(spot)),
                    UrlButton("Citymapper", citymapper_url(spot)),
                    UrlButton("Waze", waze_url(spot)),
                ]
            )

    return rows


def pager_row(context: dict, page: int, total_pages: int, kind: str) -> list:
    """Previous and next buttons, only where they lead somewhere."""
    context = {key: value for key, value in context.items() if key != NAV_OPEN}
    row = []
    if page > 0:
        row.append(ActionButton("‹ Back", kind, {**context, "page": page - 1}))
    if total_pages > 1:
        row.append(ActionButton(f"{page + 1} of {total_pages}", "noop", {}))
    if page < total_pages - 1:
        row.append(ActionButton("Next ›", kind, {**context, "page": page + 1}))
    return row


def paginate(items: list, page: int, size: int) -> tuple[list, int, int]:
    """Clamp the page into range and slice it out."""
    size = max(1, min(size, PAGE_SIZE_MAX))
    total_pages = max(1, -(-len(items) // size))
    page = max(0, min(page, total_pages - 1))
    return items[page * size : (page + 1) * size], page, total_pages


async def user_from_event(event) -> tuple[int, dict]:
    """Make sure the sender has a row upstream, and return their settings."""
    sender = await event.get_sender()
    telegram_id = event.sender_id

    await sb.ensure_user(
        telegram_id,
        getattr(sender, "username", None),
        getattr(sender, "first_name", None),
    )
    settings = await sb.get_settings(telegram_id)
    return telegram_id, settings
