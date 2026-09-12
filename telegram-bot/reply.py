"""Sending and editing genuine Telegram Rich Messages over raw MTProto.

Telethon's send_message and edit_message have no way to attach the
rich_message field that Telegram added alongside Bot API 10.1, so everything
here goes through the TL requests directly. Every helper takes the same
message contract:

    rich = {"markdown": <Rich Markdown string>, "fallback": <plain text>}

The markdown is what a current client renders: headings, bold, bullet lists
and pipe tables. The fallback fills the request's required message field, and
is what an old client shows or what goes out if Telegram rejects the rich
payload. It is never allowed to be empty, and no parse_mode is ever applied to
it.

Nothing in this module knows about the persistent button layer. richtext.py
wraps these helpers and handles that.
"""

from __future__ import annotations

import logging

from telethon import types
from telethon.errors import MessageNotModifiedError
from telethon.tl import functions

log = logging.getLogger(__name__)


def _rich_markdown(rich: dict) -> types.InputRichMessageMarkdown:
    return types.InputRichMessageMarkdown(markdown=rich["markdown"])


# Editing without reply_markup keeps the old keyboard; an empty inline
# keyboard is what actually removes it.
_NO_BUTTONS = types.ReplyInlineMarkup(rows=[])


def sent_message_id(result) -> int | None:
    """Id of the message a raw send created (bot sends come back as Updates)."""
    if isinstance(result, (types.Message, types.UpdateShortSentMessage)):
        return result.id
    for update in getattr(result, "updates", []):
        if isinstance(update, types.UpdateMessageID):
            return update.id
        if isinstance(update, (types.UpdateNewMessage, types.UpdateNewChannelMessage)):
            return update.message.id
    return None


async def send_rich_message(client, entity, rich: dict, buttons=None):
    markup = client.build_reply_markup(buttons) if buttons else None
    try:
        return await client(
            functions.messages.SendMessageRequest(
                peer=entity,
                message=rich["fallback"],
                rich_message=_rich_markdown(rich),
                reply_markup=markup,
            )
        )
    except Exception as err:  # noqa: BLE001 - the plain send is the safety net
        log.warning("[send_rich_message] rich send failed, falling back: %s", err)
        return await client.send_message(entity, rich["fallback"], buttons=buttons)


async def edit_rich_message_at(client, peer, msg_id: int, rich: dict, buttons=None) -> None:
    """Edit by chat + message id. No buttons => keyboard removed."""
    markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
    try:
        await client(
            functions.messages.EditMessageRequest(
                peer=peer,
                id=msg_id,
                message=rich["fallback"],
                rich_message=_rich_markdown(rich),
                reply_markup=markup,
            )
        )
    except MessageNotModifiedError:
        return
    except Exception as err:  # noqa: BLE001
        log.warning("[edit_rich_message_at] rich edit failed, falling back: %s", err)
        # build_reply_markup passes a ready made markup straight through, so
        # the empty keyboard clears the buttons on this path as well.
        await client.edit_message(peer, msg_id, text=rich["fallback"], buttons=markup)


async def edit_rich_message(client, event, rich: dict, buttons=None) -> None:
    """Edit the message a CallbackQuery came from, in a chat or in inline mode.

    No buttons => keyboard removed, the same as edit_rich_message_at. Every
    buttonless edit in this bot is a confirmation replacing a prompt, and the
    prompt's Approve or Yes button must not survive it.
    """
    markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
    is_inline = isinstance(event.query, types.UpdateInlineBotCallbackQuery)
    try:
        if is_inline:
            await client(
                functions.messages.EditInlineBotMessageRequest(
                    id=event.query.msg_id,
                    message=rich["fallback"],
                    rich_message=_rich_markdown(rich),
                    reply_markup=markup,
                )
            )
        else:
            await client(
                functions.messages.EditMessageRequest(
                    peer=event.query.peer,
                    id=event.query.msg_id,
                    message=rich["fallback"],
                    rich_message=_rich_markdown(rich),
                    reply_markup=markup,
                )
            )
    except MessageNotModifiedError:
        return
    except Exception as err:  # noqa: BLE001
        log.warning("[edit_rich_message] rich edit failed, falling back: %s", err)
        if is_inline:
            await client.edit_message(event.query.msg_id, text=rich["fallback"], buttons=markup)
        else:
            await client.edit_message(
                event.query.peer, event.query.msg_id, text=rich["fallback"], buttons=markup
            )
