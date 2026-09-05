"""Approval prompts for backup code generation.

Backup codes are created on the website, not here, but they are not handed over
until a human approves the request in this chat. That is the whole point: a
browser that is already linked is not by itself enough to mint credentials that
would survive losing Telegram. Someone has to say yes on the account itself.

How the two halves meet
    The website inserts a row into sgbp_backup_requests and starts polling.
    The bot polls the same table for pending rows, sends a prompt, and writes
    back either approved or declined. The website sees approved, generates the
    codes, stores their hashes and shows them once.

Polling rather than a webhook is deliberate. It means the VPS needs no inbound
port, no domain and no TLS certificate, and a restart mid flight costs nothing
because the next tick picks the request up again.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import database
import supabase_client as sb
from handlers import callbacks
from richtext import ActionButton, edit_rich_message, send_rich_message

log = logging.getLogger(__name__)

POLL_SECONDS = 5


def _expired(value: str | None) -> bool:
    if not value:
        return False
    try:
        expires = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    return expires < datetime.now(timezone.utc)


def make_poll_job(client):
    """Build the scheduler handler that watches for new requests."""

    async def poll(payload: dict) -> None:
        try:
            requests = await sb.pending_backup_requests()
        except Exception:  # noqa: BLE001 - upstream hiccups are retried next tick
            log.warning("Could not poll for backup requests", exc_info=True)
            return

        for request in requests:
            request_id = str(request["id"])

            # The local guard is what stops a prompt going out twice if two
            # ticks overlap or a write back fails partway.
            if not database.mark_request_notified(request_id):
                continue

            if _expired(request.get("expires_at")):
                await sb.mark_backup_request(request_id, "expired")
                continue

            telegram_id = int(request["telegram_id"])

            try:
                message = await send_rich_message(
                    client,
                    telegram_id,
                    title="Approve new backup codes?",
                    body=(
                        "Someone using your linked browser has asked for a new set "
                        "of backup codes.\n\n"
                        "Backup codes restore your favourites onto a new browser "
                        "without needing Telegram at all, so only approve this if "
                        "it was you.\n\n"
                        "Approving cancels any codes you were given before. The new "
                        "set is shown in the browser once and cannot be retrieved "
                        "again."
                    ),
                    footer="This request expires in ten minutes.",
                    buttons=[
                        [
                            ActionButton("Approve", "backup.approve", {"request_id": request_id}),
                            ActionButton("Decline", "backup.decline", {"request_id": request_id}),
                        ]
                    ],
                    user_id=telegram_id,
                )
            except Exception:  # noqa: BLE001
                # Most likely the person has never opened a chat here, or has
                # blocked the bot. Declining is the safe resolution.
                log.warning("Could not prompt %s for backup codes", telegram_id, exc_info=True)
                await sb.mark_backup_request(request_id, "declined")
                continue

            await sb.mark_backup_request(
                request_id,
                "notified",
                chat_id=message.chat_id,
                message_id=message.id,
            )

    return poll


def make_housekeeping_job():
    """Expire stale tokens and requests, and trim the local cache."""

    async def housekeeping(payload: dict) -> None:
        database.cache_purge_expired()
        try:
            await sb.expire_stale()
        except Exception:  # noqa: BLE001
            log.warning("Housekeeping call failed", exc_info=True)

    return housekeeping


async def _decide(event, request_id: str, approve: bool) -> None:
    request = await sb.get_backup_request(request_id)

    if request is None:
        await edit_rich_message(
            event,
            title="Request not found",
            body="That request is no longer on record. Nothing was changed.",
            user_id=event.sender_id,
        )
        await event.answer()
        return

    # Guard against approving something that belongs to a different account,
    # even though the button is already bound to its owner.
    if int(request["telegram_id"]) != event.sender_id:
        await event.answer("That request is not yours.", alert=True)
        return

    if request["status"] not in {"pending", "notified"}:
        await edit_rich_message(
            event,
            title="Already handled",
            body=(
                "This request has already been dealt with. If you still need "
                "backup codes, start again from the web app."
            ),
            user_id=event.sender_id,
        )
        await event.answer()
        return

    if _expired(request.get("expires_at")):
        await sb.mark_backup_request(request_id, "expired")
        await edit_rich_message(
            event,
            title="Request expired",
            body=(
                "This request sat unanswered for more than ten minutes, so it "
                "has lapsed. Start it again from the web app if you still want "
                "the codes."
            ),
            user_id=event.sender_id,
        )
        await event.answer()
        return

    await sb.mark_backup_request(request_id, "approved" if approve else "declined")

    if approve:
        await edit_rich_message(
            event,
            title="Approved",
            body=(
                "Your new backup codes are on their way to the browser that asked "
                "for them. They are shown once, so save them somewhere safe and "
                "offline.\n\n"
                "Any codes issued before this moment no longer work."
            ),
            user_id=event.sender_id,
        )
        await event.answer("Approved")
    else:
        await edit_rich_message(
            event,
            title="Declined",
            body=(
                "No codes were created and nothing changed. Your existing codes, "
                "if you have any, still work.\n\n"
                "If this was not you, consider running /unlink to disconnect "
                "every browser, then linking again from a device you trust."
            ),
            user_id=event.sender_id,
        )
        await event.answer("Declined")


@callbacks.on("backup.approve")
async def cb_approve(event, payload, action) -> None:
    await _decide(event, str(payload.get("request_id")), approve=True)


@callbacks.on("backup.decline")
async def cb_decline(event, payload, action) -> None:
    await _decide(event, str(payload.get("request_id")), approve=False)
