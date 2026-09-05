"""Address lookup for free text searches.

Two sources, tried in order.

OneMap
    Singapore's own address and postal code service, run by SLA. It is open,
    needs no key for search, and knows about block numbers, building names and
    six digit postal codes in a way a global geocoder does not.

Nominatim
    The OpenStreetMap geocoder the web app already uses, kept as a fallback for
    anything OneMap does not recognise. Its usage policy asks for at most one
    request per second and a real User-Agent, both of which are honoured here.

Results are cached in SQLite for a week, since addresses do not move.
"""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

import database
from config import GEOCODE_CACHE_TTL_SECONDS, USER_AGENT

log = logging.getLogger(__name__)

ONEMAP_URL = "https://www.onemap.gov.sg/api/common/elastic/search"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Singapore's bounding box, used to throw out anything obviously off the map.
SG_BOUNDS = (1.15, 103.55, 1.50, 104.10)

_client: httpx.AsyncClient | None = None
_nominatim_lock = asyncio.Lock()
_last_nominatim_call = 0.0


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en"},
            timeout=httpx.Timeout(15.0),
        )
    return _client


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def in_singapore(lat: float, lng: float) -> bool:
    south, west, north, east = SG_BOUNDS
    return south <= lat <= north and west <= lng <= east


async def _try_onemap(query: str) -> dict | None:
    params = {"searchVal": query, "returnGeom": "Y", "getAddrDetails": "Y", "pageNum": "1"}
    res = await client().get(ONEMAP_URL, params=params)
    res.raise_for_status()
    results = res.json().get("results") or []
    if not results:
        return None

    top = results[0]
    try:
        lat = float(top["LATITUDE"])
        lng = float(top["LONGITUDE"])
    except (KeyError, TypeError, ValueError):
        return None

    if not in_singapore(lat, lng):
        return None

    name = top.get("SEARCHVAL") or top.get("ADDRESS") or query
    return {"lat": lat, "lng": lng, "name": name.title(), "source": "OneMap"}


async def _try_nominatim(query: str) -> dict | None:
    global _last_nominatim_call

    # One request per second at most, as the usage policy asks.
    async with _nominatim_lock:
        gap = time.monotonic() - _last_nominatim_call
        if gap < 1.0:
            await asyncio.sleep(1.0 - gap)
        _last_nominatim_call = time.monotonic()

        params = {"q": f"{query}, Singapore", "format": "json", "limit": "1"}
        res = await client().get(NOMINATIM_URL, params=params)
        res.raise_for_status()
        results = res.json()

    if not results:
        return None

    lat = float(results[0]["lat"])
    lng = float(results[0]["lon"])
    if not in_singapore(lat, lng):
        return None

    display = results[0].get("display_name", query)
    return {
        "lat": lat,
        "lng": lng,
        "name": ", ".join(display.split(",")[:2]).strip(),
        "source": "OpenStreetMap",
    }


async def lookup(query: str) -> dict | None:
    """Resolve a place name, address or postal code to a coordinate."""
    query = query.strip()
    if not query:
        return None

    key = f"geo:{query.lower()}"
    cached = database.cache_get(key)
    if cached is not None:
        # A previous miss is cached as False so a nonsense query is not retried.
        return cached or None

    result = None
    for attempt in (_try_onemap, _try_nominatim):
        try:
            result = await attempt(query)
        except httpx.HTTPError as exc:
            log.warning("Geocoder %s failed for %r: %s", attempt.__name__, query, exc)
            continue
        if result:
            break

    database.cache_set(key, result or False, GEOCODE_CACHE_TTL_SECONDS)
    return result
