"""Per person search preferences.

Settings live in Supabase alongside the user row rather than in the local
database, so they follow the account rather than the machine the bot happens to
be running on.
"""

from __future__ import annotations

import supabase_client as sb
from config import RADIUS_CHOICES
from handlers import callbacks
from handlers.common import user_from_event
from richtext import ActionButton, Table, compose, edit_rich_message, send_rich_message

RESULT_CHOICES = (3, 5, 8)


def build_settings_view(settings: dict) -> tuple[dict, list]:
    radius = float(settings.get("radius") or 0.5)
    limit = int(settings.get("result_limit") or 5)
    sheltered = bool(settings.get("sheltered_only"))

    rich = compose(
        "Search settings",
        Table(
            ["Value"],
            [
                ["Search radius", f"{radius:g}km around wherever you are looking"],
                [
                    "Sheltered only",
                    "On, unsheltered racks are hidden" if sheltered else "Off, everything is shown",
                ],
                ["Results per page", limit],
            ],
        ),
        footer="These apply to searches here. The web app keeps its own controls.",
    )

    buttons = [
        [
            ActionButton(
                f"{'●' if choice == radius else '○'} {choice:g}km",
                "settings.radius",
                {"radius": choice},
            )
            for choice in RADIUS_CHOICES
        ],
        [
            ActionButton(
                f"Sheltered only: {'on' if sheltered else 'off'}",
                "settings.sheltered",
                {"value": not sheltered},
            )
        ],
        [
            ActionButton(
                f"{'●' if choice == limit else '○'} {choice} results",
                "settings.limit",
                {"value": choice},
            )
            for choice in RESULT_CHOICES
        ],
    ]

    return rich, buttons


async def cmd_settings(event) -> None:
    telegram_id, settings = await user_from_event(event)

    rich, buttons = build_settings_view(settings)
    await send_rich_message(event.client, event.chat_id, rich, buttons, user_id=telegram_id)


async def _apply(event, changes: dict, note: str) -> None:
    telegram_id = event.sender_id
    settings = await sb.get_settings(telegram_id)
    settings.update(changes)
    await sb.save_settings(telegram_id, settings)

    rich, buttons = build_settings_view(settings)
    await edit_rich_message(event.client, event, rich, buttons, user_id=telegram_id)
    await event.answer(note)


@callbacks.on("settings.radius")
async def cb_radius(event, payload, action) -> None:
    value = float(payload.get("radius") or 0.5)
    await _apply(event, {"radius": value}, f"Radius set to {value:g}km")


@callbacks.on("settings.sheltered")
async def cb_sheltered(event, payload, action) -> None:
    value = bool(payload.get("value"))
    await _apply(
        event,
        {"sheltered_only": value},
        "Showing sheltered racks only" if value else "Showing every rack",
    )


@callbacks.on("settings.limit")
async def cb_limit(event, payload, action) -> None:
    value = int(payload.get("value") or 5)
    await _apply(event, {"result_limit": value}, f"Showing {value} results per page")
