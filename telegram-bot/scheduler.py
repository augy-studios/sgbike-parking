"""A small durable scheduler backed by the jobs table in SQLite.

Anything the bot needs to do later goes through here rather than through
asyncio.sleep, so pending work survives a restart. That matters most for the
backup code approval prompts, which are picked up by polling Supabase: if the
process dies between a request being raised on the site and the prompt being
sent in chat, the poll simply happens again on the next tick.

Handlers are async callables that take the job payload as their only argument.
A handler that raises is retried with a backoff, and a one shot job that keeps
failing is eventually marked failed rather than retried forever.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable

import database

log = logging.getLogger(__name__)

JobHandler = Callable[[dict], Awaitable[None]]

TICK_SECONDS = 1.0


class Scheduler:
    def __init__(self) -> None:
        self._handlers: dict[str, JobHandler] = {}
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()

    def register(self, kind: str, handler: JobHandler) -> None:
        self._handlers[kind] = handler

    def every(
        self,
        kind: str,
        seconds: int,
        *,
        payload: dict | None = None,
        start_after: float = 5,
    ) -> None:
        """Declare a recurring job. Idempotent, so restarts do not duplicate it."""
        database.schedule_job(
            kind,
            run_in_seconds=start_after,
            payload=payload,
            interval_seconds=seconds,
            unique_key=f"recurring:{kind}",
        )

    def once(self, kind: str, *, delay: float = 0, payload: dict | None = None) -> int:
        return database.schedule_job(kind, run_in_seconds=delay, payload=payload)

    async def _run_job(self, job) -> None:
        handler = self._handlers.get(job["kind"])
        if handler is None:
            log.warning("No handler registered for job kind %r, dropping it", job["kind"])
            database.mark_job_done(job)
            return

        try:
            payload = json.loads(job["payload"] or "{}")
        except json.JSONDecodeError:
            payload = {}

        try:
            await handler(payload)
        except Exception as exc:  # noqa: BLE001 - a bad job must not kill the loop
            log.exception("Job %s (%s) failed", job["id"], job["kind"])
            database.mark_job_failed(job, str(exc))
        else:
            database.mark_job_done(job)

    async def _loop(self) -> None:
        log.info("Scheduler started with handlers: %s", ", ".join(sorted(self._handlers)))
        while not self._stopping.is_set():
            try:
                for job in database.due_jobs():
                    await self._run_job(job)
            except Exception:  # noqa: BLE001 - keep ticking whatever happens
                log.exception("Scheduler tick failed")

            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=TICK_SECONDS)
            except asyncio.TimeoutError:
                pass

        log.info("Scheduler stopped")

    def start(self) -> asyncio.Task:
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="scheduler")
        return self._task

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
            self._task = None
