# 🚆 Train Tracker

A self-hosted live UK train tracking app built on Docker, powered by the [Realtime Trains NG API](https://api-portal.rtt.io/) and real Network Rail track geometry.

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Docker](https://img.shields.io/badge/docker-compose-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

### 🗺️ Live Map
- **Real track geometry** — route polyline follows actual Network Rail track, sourced from [raileasyuk/railway-gis-data](https://github.com/raileasyuk/railway-gis-data)
- **Colour-coded stop markers** — departed (green) / due or late (amber) / upcoming (grey) / cancelled (red)
- **Estimated train position** — interpolated between last reported and next stop, shown as a pulsing 🚂 icon
- **Signal status** — approaching / arriving / at platform / preparing to depart (requires RTT detailed API access)
- **Map tile toggle** — Dark (Carto), Light (OSM), Satellite (Esri), persisted in localStorage

### 🚉 Departure Board
- Search by origin station with optional destination filter
- 2-hour rolling window, configurable from time
- Auto-refresh toggle
- On-time / late status badges with delay minutes
- Platform numbers where available
- **Inline calling points** — expand any service to see all stops with realtime times, no page navigation needed

### 🔢 Headcode Lookup
- Enter a headcode (e.g. `1J54`) and date
- Searches across major GB stations to find the matching service
- One click to track on the map

### ★ Favourites
- Save services to localStorage for one-click "Track today" access

### 📊 Service Detail
- **Journey progress bar** — % of stops completed with live position indicator
- **Rolling stock** — class, coach count, unit numbers from RTT allocation data
- **Delay reasons** — human-readable RTT reason codes surfaced as banners
- **Direct UID lookup** — enter a service UID and date

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + React-Leaflet |
| Backend | FastAPI (Python 3.12) |
| Station DB | SQLite — built from open NaPTAN data at container startup |
| Track geometry | Network Rail GIS data via raileasyuk/railway-gis-data, baked into image |
| Routing | Dijkstra on OSM node graph with node snapping + gap bridging |
| Data source | [Realtime Trains NG API](https://data.rtt.io) |
| Deployment | Docker Compose (two containers + named volume) |

---

## Prerequisites

- Docker + Docker Compose
- A free RTT API token from **https://api-portal.rtt.io** (personal non-commercial use)

---

## Quick start

```bash
git clone https://github.com/catfordfire/train-tracker.git
cd train-tracker

cp .env.example .env
# Edit .env and add: RTT_API_TOKEN=your_token_here

docker compose up -d --build
```

Then open **http://localhost:47200**

First startup downloads ~2,600 UK station coordinates into a persistent SQLite volume. The track geometry is pre-bundled in the image.

---

## Ports

| Service | Host port |
|---|---|
| Frontend (nginx + React) | **47200** |
| Backend (FastAPI) | **47201** (debug only) |

---

## Configuration

| Variable | Description |
|---|---|
| `RTT_API_TOKEN` | Your RTT refresh token from api-portal.rtt.io |

---

## Remote access

The app binds to `0.0.0.0:47200` so it's immediately accessible via [Tailscale](https://tailscale.com/) at `http://<nas-tailscale-ip>:47200` — no additional config needed.

---

## Finding service UIDs and headcodes

- Go to [realtimetrains.co.uk](https://www.realtimetrains.co.uk) and find a service
- The URL contains the UID: `.../service/gb-nr:C16998/...` → UID is `C16998`
- The headcode (e.g. `1J54`) is shown on the service page as the train identity

---

## Architecture

```
Browser :47200
  │
  ├── nginx (React SPA)
  └── /api/* → FastAPI :8889
                  │
                  ├── RTT NG API (Bearer token, data.rtt.io)
                  ├── SQLite stations DB (CRS/TIPLOC → lat/lon)
                  ├── SQLite track cache (routed segment cache)
                  └── rail_network.json (Network Rail track geometry)
```

Your RTT token never reaches the browser — kept server-side in FastAPI.

---

## Track routing

Routes are computed using Dijkstra's algorithm over a graph built from Network Rail GIS track geometry:

1. For each consecutive station pair, load nearby track segments from SQLite
2. Build a node graph, snapping nearby endpoints to bridge data gaps
3. Find shortest path via Dijkstra
4. Sanity-check: reject routes > 3.5× straight-line distance
5. Cache result by `(from_crs, to_crs)` — subsequent loads are instant

Falls back to a dashed straight line where track data is missing or routing fails.

---

## Updating

```bash
git pull
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## Rate limits (RTT NG API)

30 req/min · 750/hr · 9,000/day · 30,000/week

Auto-refresh uses 1 request per 30 seconds — well within limits.

---

## Data sources

- **Train data**: [Realtime Trains](https://www.realtimetrains.co.uk) — © Swlines Ltd
- **Track geometry**: [raileasyuk/railway-gis-data](https://github.com/raileasyuk/railway-gis-data)
- **Station coordinates**: [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) — ODbL
- **Map tiles**: © OpenStreetMap / © CARTO / © Esri

---

## Licence

MIT
