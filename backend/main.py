"""
Train Tracker Backend - FastAPI proxy for Realtime Trains NG API
Base URL: https://data.rtt.io
"""
import os
import sqlite3
import httpx
import asyncio
from track_router import route_full_service
from datetime import date, datetime, timezone, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Train Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RTT_BASE          = "https://data.rtt.io"
RTT_REFRESH_TOKEN = os.environ.get("RTT_API_TOKEN", "")
DB_PATH           = "/data/stations.db"
API_VERSION       = "2026-05-19"

_access_token        = ""
_access_token_expiry = datetime.min.replace(tzinfo=timezone.utc)
_token_lock          = asyncio.Lock()


async def get_access_token() -> str:
    global _access_token, _access_token_expiry
    now = datetime.now(timezone.utc)
    if _access_token and now < _access_token_expiry:
        return _access_token
    async with _token_lock:
        now = datetime.now(timezone.utc)
        if _access_token and now < _access_token_expiry:
            return _access_token
        if not RTT_REFRESH_TOKEN:
            raise HTTPException(status_code=500, detail="RTT_API_TOKEN not configured")
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{RTT_BASE}/api/get_access_token",
                headers={"Authorization": f"Bearer {RTT_REFRESH_TOKEN}", "Accept": "application/json", "Version": API_VERSION},
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Token exchange failed ({resp.status_code}): {resp.text[:200]}")
        data = resp.json()
        _access_token = data.get("token", "")
        if not _access_token:
            raise HTTPException(status_code=502, detail=f"No token in response: {data}")
        valid_until = data.get("validUntil")
        if valid_until:
            try:
                _access_token_expiry = datetime.fromisoformat(valid_until.replace("Z", "+00:00")) - timedelta(seconds=60)
            except Exception:
                _access_token_expiry = datetime.now(timezone.utc) + timedelta(minutes=55)
        else:
            _access_token_expiry = datetime.now(timezone.utc) + timedelta(minutes=55)
        return _access_token


async def rtt_get(path: str) -> httpx.Response:
    token = await get_access_token()
    async with httpx.AsyncClient(timeout=15) as client:
        return await client.get(
            f"{RTT_BASE}{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Version": API_VERSION},
        )


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "token_set": bool(RTT_REFRESH_TOKEN)}


@app.get("/api/debug")
async def debug():
    results = {"refresh_token_set": bool(RTT_REFRESH_TOKEN)}
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            tr = await client.get(
                f"{RTT_BASE}/api/get_access_token",
                headers={"Authorization": f"Bearer {RTT_REFRESH_TOKEN}", "Accept": "application/json", "Version": API_VERSION},
            )
            results["get_access_token"] = {"status": tr.status_code, "body": tr.text[:500]}
            if tr.status_code == 200:
                tok = tr.json().get("token", "")
                if tok:
                    ir = await client.get(
                        f"{RTT_BASE}/api/info",
                        headers={"Authorization": f"Bearer {tok}", "Accept": "application/json", "Version": API_VERSION},
                    )
                    results["api_info"] = {"status": ir.status_code, "body": ir.text[:1000]}
        except Exception as e:
            results["error"] = str(e)
    return results


@app.get("/api/rawdebug/{service_uid}")
async def raw_debug(service_uid: str, run_date: Optional[str] = Query(None)):
    if run_date is None:
        run_date = date.today().isoformat()
    token = await get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Version": API_VERSION}
    paths = [
        f"/gb-nr/service?identity={service_uid}&departureDate={run_date}&detailed=true",
        f"/gb-nr/service?uniqueIdentity=gb-nr:{service_uid}:{run_date}",
    ]
    results = {}
    async with httpx.AsyncClient(timeout=10) as client:
        for path in paths:
            try:
                r = await client.get(f"{RTT_BASE}{path}", headers=headers)
                results[path] = {"status": r.status_code, "body": r.text[:500]}
            except Exception as e:
                results[path] = {"error": str(e)}
    return results


@app.get("/api/service/{service_uid}")
async def get_service(
    service_uid: str,
    run_date: Optional[str] = Query(None, description="YYYY-MM-DD, defaults to today"),
):
    if run_date is None:
        run_date = date.today().isoformat()

    resp = await rtt_get(f"/gb-nr/service?identity={service_uid}&departureDate={run_date}&detailed=true")

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"Service {service_uid} not found for {run_date}")
    if resp.status_code == 401:
        global _access_token
        _access_token = ""
        raise HTTPException(status_code=401, detail="RTT access token expired — retry")
    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="RTT rate limit exceeded")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"RTT error ({resp.status_code}): {resp.text[:300]}")

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"Non-JSON from RTT: {resp.text[:300]}")

    return enrich_with_coords(data)


@app.get("/api/station/{crs}")
async def get_station_departures(
    crs: str,
    run_date: Optional[str] = Query(None),
    time: Optional[str] = Query(None),
    window: int = Query(120),
    filter_to: Optional[str] = Query(None),
):
    if run_date is None:
        run_date = date.today().isoformat()

    # Build timeFrom as full ISO datetime — NG API param is timeFrom, not date
    if time and len(time) == 4:
        time_str = f"{time[:2]}:{time[2:]}"
    elif time and len(time) == 5:
        time_str = time
    else:
        now = datetime.now()
        time_str = f"{now.hour:02d}:{now.minute:02d}"

    time_from = f"{run_date}T{time_str}:00"
    path = f"/gb-nr/location?code={crs.upper()}&timeFrom={time_from}&timeWindow={window}&detailed=true"

    if filter_to:
        path += f"&filterTo={filter_to.upper()}"

    resp = await rtt_get(path)
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"RTT error: {resp.text[:300]}")
    return resp.json()


@app.get("/api/headcode/{headcode}")
async def search_by_headcode(
    headcode: str,
    run_date: Optional[str] = Query(None),
):
    """
    Find a service by headcode (e.g. 1J54) for a given date.
    Searches a spread of major stations across a full-day window.
    Returns the first matching service identity + departure date.
    """
    if run_date is None:
        run_date = date.today().isoformat()

    headcode = headcode.upper()
    # Search a handful of major interchange stations across the day
    probe_stations = ["EUS", "PAD", "VIC", "WAT", "BHM", "MAN", "LDS", "BRI",
                      "NCL", "EDB", "GLC", "SHR", "EXD", "NRW", "CBG", "YRK"]

    time_from = f"{run_date}T00:00:00"

    async with httpx.AsyncClient(timeout=15) as client:
        token = await get_access_token()
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json", "Version": API_VERSION}

        for crs in probe_stations:
            url = f"{RTT_BASE}/gb-nr/location?code={crs}&timeFrom={time_from}&timeWindow=1439"
            try:
                r = await client.get(url, headers=headers)
                if r.status_code != 200:
                    continue
                data = r.json()
                for svc in data.get("services", []):
                    meta = svc.get("scheduleMetadata", {})
                    if meta.get("trainReportingIdentity", "").upper() == headcode:
                        return {
                            "found": True,
                            "identity": meta.get("identity"),
                            "departureDate": meta.get("departureDate"),
                            "trainReportingIdentity": meta.get("trainReportingIdentity"),
                            "operator": meta.get("operator", {}).get("name"),
                            "origin": svc.get("origin", [{}])[0].get("location", {}).get("description"),
                            "destination": svc.get("destination", [{}])[0].get("location", {}).get("description"),
                        }
            except Exception:
                continue

    return {"found": False, "headcode": headcode, "date": run_date}


@app.get("/api/stations/tiplocs/{crs}")
def station_tiplocs(crs: str):
    """Return all known TIPLOCs for a given CRS code."""
    conn = get_db()
    rows = conn.execute(
        "SELECT tiploc FROM stations WHERE UPPER(crs) = ? AND tiploc IS NOT NULL",
        (crs.upper(),)
    ).fetchall()
    conn.close()
    return [row["tiploc"] for row in rows]


@app.get("/api/stations/search")
def search_stations(q: str = Query(..., min_length=2)):
    conn = get_db()
    rows = conn.execute(
        """SELECT crs, name, lat, lon FROM stations
           WHERE UPPER(name) LIKE ? OR UPPER(crs) LIKE ?
           ORDER BY name LIMIT 20""",
        (f"%{q.upper()}%", f"%{q.upper()}%"),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/route/{service_uid}")
async def get_service_route(
    service_uid: str,
    run_date: Optional[str] = Query(None),
):
    """
    Returns the full routed track geometry for a service as a list of [lat,lon] waypoints.
    First fetches the service to get stop coordinates, then routes each segment
    via Overpass API (with SQLite caching). Falls back to straight lines on error.
    """
    if run_date is None:
        run_date = date.today().isoformat()

    resp = await rtt_get(f"/gb-nr/service?identity={service_uid}&departureDate={run_date}&detailed=true")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=f"RTT error: {resp.text[:200]}")

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="Non-JSON from RTT")

    enriched = enrich_with_coords(data)
    locations = enriched.get("service", {}).get("locations", [])

    route = await route_full_service(locations)
    return {"route": route, "segments": len(route)}


def enrich_with_coords(service_data: dict) -> dict:
    """Add lat/lon to each location using local stations DB."""
    locations = service_data.get("service", {}).get("locations", [])
    if not locations:
        return service_data

    # NG API: location.shortCodes = [CRS], location.longCodes = [TIPLOCs]
    crs_codes = list({
        loc["location"]["shortCodes"][0]
        for loc in locations
        if loc.get("location", {}).get("shortCodes")
    })
    tiplocs = list({
        code
        for loc in locations
        for code in loc.get("location", {}).get("longCodes", [])
    })

    conn = get_db()
    coord_map = {}

    if crs_codes:
        ph = ",".join("?" * len(crs_codes))
        for row in conn.execute(f"SELECT crs, lat, lon FROM stations WHERE crs IN ({ph})", crs_codes):
            coord_map[row["crs"]] = {"lat": row["lat"], "lon": row["lon"]}

    if tiplocs:
        ph = ",".join("?" * len(tiplocs))
        for row in conn.execute(f"SELECT tiploc, lat, lon FROM stations WHERE tiploc IN ({ph})", tiplocs):
            coord_map[f"T:{row['tiploc']}"] = {"lat": row["lat"], "lon": row["lon"]}

    conn.close()

    for loc in locations:
        crs = (loc.get("location", {}).get("shortCodes") or [None])[0]
        coords = coord_map.get(crs)
        if coords is None:
            for tiploc in loc.get("location", {}).get("longCodes", []):
                coords = coord_map.get(f"T:{tiploc}")
                if coords:
                    break
        if coords:
            loc["lat"] = coords["lat"]
            loc["lon"] = coords["lon"]

    return service_data


@app.get("/api/route_debug/{service_uid}")
async def get_route_debug(
    service_uid: str,
    run_date: Optional[str] = Query(None),
):
    """Debug endpoint - returns route diagnostics per segment."""
    if run_date is None:
        run_date = date.today().isoformat()

    resp = await rtt_get(f"/gb-nr/service?identity={service_uid}&departureDate={run_date}&detailed=true")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail="RTT error")

    data = resp.json()
    enriched = enrich_with_coords(data)
    locations = enriched.get("service", {}).get("locations", [])
    mapped = [(loc, (loc.get("location", {}).get("shortCodes") or ["?"])[0])
              for loc in locations if loc.get("lat") and loc.get("lon")]

    from track_router import haversine, fetch_track_geometry, build_graph, nearest_node
    from track_router import ensure_track_cache, get_cached_route

    segments = []
    for i in range(min(3, len(mapped) - 1)):  # first 3 segments only
        a_loc, a_crs = mapped[i]
        b_loc, b_crs = mapped[i+1]
        dist = haversine(a_loc["lat"], a_loc["lon"], b_loc["lat"], b_loc["lon"])

        conn = sqlite3.connect("/data/stations.db")
        conn.row_factory = sqlite3.Row
        ensure_track_cache(conn)
        cached = get_cached_route(conn, a_crs, b_crs)
        conn.close()

        seg = {
            "from": a_crs, "to": b_crs,
            "straight_km": round(dist, 2),
            "cached": cached is not None,
            "cached_points": len(cached) if cached else 0,
        }

        if not cached:
            try:
                osm = await fetch_track_geometry(a_loc["lat"], a_loc["lon"], b_loc["lat"], b_loc["lon"])
                nodes, edges = build_graph(osm)
                sn, sd = nearest_node(nodes, a_loc["lat"], a_loc["lon"])
                en, ed = nearest_node(nodes, b_loc["lat"], b_loc["lon"])
                seg["osm_ways"] = len([e for e in osm.get("elements",[]) if e.get("type")=="way"])
                seg["osm_nodes"] = len(nodes)
                seg["start_snap_km"] = round(sd, 3)
                seg["end_snap_km"] = round(ed, 3)
                seg["start_node"] = list(sn) if sn else None
                seg["end_node"] = list(en) if en else None
            except Exception as e:
                seg["error"] = str(e)
        else:
            seg["sample_points"] = cached[:3]

        segments.append(seg)

    return {"stops": len(mapped), "segments": segments}
