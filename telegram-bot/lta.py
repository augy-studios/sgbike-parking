"""LTA DataMall bicycle parking lookups, with a local cache.

DataMall refreshes this dataset monthly, so caching a rounded coordinate for a
few hours costs nothing in accuracy and keeps the bot well clear of any rate
limit. The cache lives in SQLite, which means it also survives a restart.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import httpx

import database
from config import LTA_ACCOUNT_KEY, LTA_CACHE_TTL_SECONDS, LTA_ENDPOINT, USER_AGENT

log = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={
                "AccountKey": LTA_ACCOUNT_KEY,
                "accept": "application/json",
                "User-Agent": USER_AGENT,
            },
            timeout=httpx.Timeout(20.0),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great circle distance in kilometres."""
    radius = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def format_distance(km: float | None) -> str:
    if km is None:
        return "distance unknown"
    if km < 1:
        return f"{round(km * 1000)}m"
    return f"{km:.2f}km"


def normalise(record: dict[str, Any], origin: tuple[float, float] | None = None) -> dict:
    """Flatten an LTA record into the shape used everywhere else in the bot."""
    lat = record.get("Latitude")
    lng = record.get("Longitude")
    spot = {
        "code": str(record.get("Description", "")).strip(),
        "description": str(record.get("Description", "")).strip(),
        "rack_type": record.get("RackType") or "Racks",
        "rack_count": record.get("RackCount") or 0,
        "sheltered": record.get("ShelterIndicator") == "Y",
        "latitude": lat,
        "longitude": lng,
    }
    if origin and lat is not None and lng is not None:
        spot["distance_km"] = haversine(origin[0], origin[1], lat, lng)
    return spot


async def nearby(lat: float, lng: float, dist_km: float = 0.5) -> list[dict]:
    """Bicycle parking near a point, nearest first.

    Coordinates are rounded to three decimal places for the cache key, which is
    roughly a hundred metres. Two searches from the same street corner share a
    single upstream call.
    """
    key = f"lta:{round(lat, 3)}:{round(lng, 3)}:{dist_km}"
    cached = database.cache_get(key)

    if cached is None:
        params = {"Lat": f"{lat:.6f}", "Long": f"{lng:.6f}", "Dist": str(dist_km)}
        try:
            res = await client().get(LTA_ENDPOINT, params=params)
            res.raise_for_status()
            cached = res.json().get("value", [])
            database.cache_set(key, cached, LTA_CACHE_TTL_SECONDS)
        except httpx.HTTPError as exc:
            log.warning("LTA lookup failed for %s, %s: %s", lat, lng, exc)
            raise

    spots = [normalise(record, origin=(lat, lng)) for record in cached]
    spots.sort(key=lambda s: s.get("distance_km", float("inf")))
    return spots


def apply_filters(spots: list[dict], *, sheltered_only: bool = False) -> list[dict]:
    if sheltered_only:
        return [s for s in spots if s.get("sheltered")]
    return spots
