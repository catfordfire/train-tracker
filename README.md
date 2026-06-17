# Train Tracker 🚆

A self-hosted live UK train tracker with real-time map, running on Docker.

**Data source:** [Realtime Trains NG API](https://api-portal.rtt.io/)  
**Station coordinates:** [davwheat/uk-railway-stations](https://github.com/davwheat/uk-railway-stations) (ODbL)

---

## Prerequisites

- Docker + Docker Compose on your Synology NAS
- A free RTT API token from **https://api-portal.rtt.io/** (personal non-commercial use)

---

## Setup

### 1. Clone / copy files to your NAS

```bash
# e.g. via SSH
scp -r train-tracker/ blagadmin@192.168.1.57:/volume1/docker/train-tracker
```

### 2. Configure your API token

```bash
cd /volume1/docker/train-tracker
cp .env.example .env
nano .env
# Set: RTT_API_TOKEN=your_actual_token_here
```

### 3. Build and launch

```bash
docker compose up -d --build
```

First run will:
- Build both containers
- Download ~2,600 UK station coordinates into a persistent SQLite volume
- Start serving on **http://192.168.1.57:8888**

### 4. Use it

1. Find a service UID on [realtimetrains.co.uk](https://www.realtimetrains.co.uk) — it's in the URL, e.g. `W33919`
2. Open `http://192.168.1.57:8888`
3. Enter the UID and date → Track

---

## Features

- **Live route map** with OpenStreetMap tiles (no API key needed)
- **Stop list** colour-coded by status: departed ✅ / due 🟡 / upcoming ⚪ / cancelled ❌
- **Realtime vs scheduled** time comparison with delay badges
- **Estimated train position** interpolated between last departed and next stop
- **Platform numbers** where available
- **Auto-refresh** every 30 seconds (manual refresh button too)
- Click any stop → map pans to it; click map marker → stop highlights in list

---

## Finding Service UIDs

- Go to https://www.realtimetrains.co.uk
- Search for a train / station
- Click a service — the URL contains the UID: `.../service/gb-nr:W33919/...`
- The UID is the part after `gb-nr:` → `W33919`

---

## Architecture

```
Browser :8888
  │
  ├── nginx (static React SPA)
  └── /api/* → proxy → FastAPI backend :8889
                          │
                          ├── RTT NG API (Bearer token auth)
                          └── SQLite stations DB (coords lookup)
```

The backend port (8889) is **not exposed externally** — nginx proxies it internally. Your RTT token never touches the browser.

---

## Updating

```bash
cd /volume1/docker/train-tracker
docker compose pull
docker compose up -d --build
```

To rebuild the stations DB (e.g. after new stations open):
```bash
docker exec train-tracker-backend rm /data/stations.db
docker restart train-tracker-backend
```

---

## Rate Limits (RTT NG API)

- 30 req/min · 750/hr · 9,000/day · 30,000/week
- The 30-second auto-refresh uses **1 request per refresh** — well within limits
- Don't track dozens of services simultaneously from multiple browser tabs

---

## Troubleshooting

**"RTT_API_TOKEN not configured"** → Check your `.env` file and rebuild  
**Service not found** → Verify the UID and date on realtimetrains.co.uk first  
**Stops missing from map** → Some minor halts/junctions lack CRS codes; TIPLOC fallback is used  
**Map shows wrong position** → Interpolation is time-based; position is estimated, not GPS  
