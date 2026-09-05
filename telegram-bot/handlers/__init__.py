"""Command, message and callback handlers.

Kept deliberately thin at package level so submodules can do
`from handlers import callbacks` without tripping over a circular import. The
wiring itself lives in bot.py.
"""
