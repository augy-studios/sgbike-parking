# SG Bike Parking 🚲

Find LTA bicycle parking locations near you in Singapore.

---

## Features

- 📍 **GPS-first** — auto-locates on load, high accuracy
- 🔍 **Address search** fallback via OpenStreetMap Nominatim geocoding
- 🗺️ **Map view** — Leaflet + OpenStreetMap with radius circle and custom pins
- 📋 **List view** — sorted by distance, count, or shelter status
- 🔽 **Radius slider** — 0.5 / 1 / 1.5 / 2 km
- ☂ **Filters** — sheltered only, rack type (Racks / Yellow Box)
- 🧭 **Navigate** — Google Maps, Waze, Apple Maps, OSM (bicycle routing)
- 📌 **In-app map modal** — no external app needed
- 🎨 **7 themes** — Classic (#ccffcc), 5 non-green pastels, white
- 📦 **PWA** — installable, offline-cached (last fetched results)
- ⚡ **Serverless proxy** — LTA API key never exposed to the client

---

## Notes

- Nominatim geocoding is rate-limited (1 req/sec, no API key needed for low usage)
- Service worker caches API responses for offline use — cached data remains valid since LTA updates monthly
- Leaflet uses OpenStreetMap tiles
