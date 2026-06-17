#!/usr/bin/env python3
"""
Build stations.db from open UK railway station data.
Run once at container startup if DB doesn't exist.
Sources:
  1. davwheat/uk-railway-stations (CRS + name + lat/lon) — primary
  2. fasteroute/national-rail-stations (TIPLOC + lat/lon) — fallback enrichment
"""
import csv
import io
import json
import os
import sqlite3
import sys
import urllib.request

DB_PATH = "/data/stations.db"
STATIONS_CSV_URL = (
    "https://raw.githubusercontent.com/davwheat/uk-railway-stations/main/stations.csv"
)
TIPLOC_JSON_URL = (
    "https://raw.githubusercontent.com/fasteroute/national-rail-stations/master/stations.json"
)


def download(url: str) -> bytes:
    print(f"  Downloading {url} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "train-tracker/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def build_db():
    os.makedirs("/data", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS stations (
            crs     TEXT,
            tiploc  TEXT,
            name    TEXT NOT NULL,
            lat     REAL,
            lon     REAL
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_crs    ON stations(crs)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_tiploc ON stations(tiploc)")
    c.execute("DELETE FROM stations")

    # --- Primary source: CRS + coords ---
    try:
        raw = download(STATIONS_CSV_URL).decode("utf-8")
        reader = csv.DictReader(io.StringIO(raw))
        rows = []
        for row in reader:
            try:
                lat = float(row["lat"])
                lon = float(row["long"])
            except (ValueError, KeyError):
                continue
            rows.append((row.get("crsCode", "").upper() or None, None, row["stationName"], lat, lon))
        c.executemany("INSERT INTO stations VALUES (?,?,?,?,?)", rows)
        print(f"  Inserted {len(rows)} stations from primary source")
    except Exception as e:
        print(f"  WARNING: primary source failed: {e}", file=sys.stderr)

    # --- Supplementary: TIPLOC + lat/lon from Darwin reference ---
    try:
        raw = download(TIPLOC_JSON_URL).decode("utf-8")
        tiploc_data = json.loads(raw)
        rows = []
        for tiploc, info in tiploc_data.items():
            lat = info.get("lat")
            lon = info.get("lon") or info.get("long")
            if lat is None or lon is None:
                continue
            crs = info.get("crs", "").upper() or None
            name = info.get("name", tiploc)
            rows.append((crs, tiploc.upper(), name, float(lat), float(lon)))

        # Only insert rows where we don't already have this CRS
        existing_crs = {r[0] for r in c.execute("SELECT crs FROM stations WHERE crs IS NOT NULL").fetchall()}
        new_rows = [r for r in rows if r[0] not in existing_crs]
        c.executemany("INSERT INTO stations VALUES (?,?,?,?,?)", new_rows)
        # Also update tiploc on existing rows that match CRS
        for r in rows:
            if r[0] in existing_crs and r[1]:
                c.execute("UPDATE stations SET tiploc=? WHERE crs=? AND tiploc IS NULL", (r[1], r[0]))
        print(f"  Inserted {len(new_rows)} additional TIPLOC entries")
    except Exception as e:
        print(f"  WARNING: TIPLOC source failed: {e}", file=sys.stderr)

    conn.commit()
    total = c.execute("SELECT COUNT(*) FROM stations").fetchone()[0]
    print(f"  DB ready: {total} total entries")
    conn.close()


if __name__ == "__main__":
    if os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 10_000:
        print("stations.db already exists, skipping rebuild")
    else:
        print("Building stations.db ...")
        build_db()
        print("Done.")
