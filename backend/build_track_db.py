"""
build_track_db.py - Run during Docker build to pre-fetch GB rail track geometry
from Overpass API and store in /data/track_segments.db

This runs at BUILD TIME when Overpass is accessible, so the container
doesn't need outbound Overpass access at runtime.

Splits GB into a grid of tiles and fetches each tile's rail geometry,
building a spatial index of track segments keyed by bounding box.
"""

import json
import math
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
DB_PATH = "/data/track_segments.db"

# GB bounding box: roughly 49.8N to 60.9N, -8.2W to 2.0E
# Split into ~0.5° tiles to keep each query manageable
GB_MIN_LAT, GB_MAX_LAT = 49.8, 60.9
GB_MIN_LON, GB_MAX_LON = -8.2, 2.1
TILE_SIZE = 0.5  # degrees


def overpass_query(min_lat, min_lon, max_lat, max_lon):
    query = f"""[out:json][timeout:60];
(
  way["railway"~"^(rail|light_rail)$"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out geom;"""
    url = OVERPASS_URL + "?data=" + urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "train-tracker-build/1.0"})
    with urllib.request.urlopen(req, timeout=65) as r:
        return json.loads(r.read())


def init_db(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS track_segments (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            min_lat REAL, max_lat REAL,
            min_lon REAL, max_lon REAL,
            coords  TEXT NOT NULL  -- JSON [[lat,lon],...]
        );
        CREATE INDEX IF NOT EXISTS idx_track_bbox
            ON track_segments(min_lat, max_lat, min_lon, max_lon);
        CREATE TABLE IF NOT EXISTS tiles_fetched (
            tile_key TEXT PRIMARY KEY,
            fetched_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()


def segments_from_ways(elements):
    """Extract individual way coordinate lists from Overpass response."""
    segs = []
    for el in elements:
        if el.get("type") != "way":
            continue
        geo = el.get("geometry", [])
        if len(geo) < 2:
            continue
        coords = [[pt["lat"], pt["lon"]] for pt in geo]
        segs.append(coords)
    return segs


def store_segments(conn, segs):
    rows = []
    for coords in segs:
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        rows.append((min(lats), max(lats), min(lons), max(lons), json.dumps(coords)))
    conn.executemany(
        "INSERT INTO track_segments (min_lat, max_lat, min_lon, max_lon, coords) VALUES (?,?,?,?,?)",
        rows
    )
    conn.commit()


def main():
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    lat = GB_MIN_LAT
    total_tiles = math.ceil((GB_MAX_LAT - GB_MIN_LAT) / TILE_SIZE) * \
                  math.ceil((GB_MAX_LON - GB_MIN_LON) / TILE_SIZE)
    done = 0

    while lat < GB_MAX_LAT:
        lon = GB_MIN_LON
        while lon < GB_MAX_LON:
            tile_key = f"{lat:.1f}_{lon:.1f}"
            already = conn.execute(
                "SELECT 1 FROM tiles_fetched WHERE tile_key=?", (tile_key,)
            ).fetchone()

            if not already:
                min_lat = round(lat, 2)
                max_lat = round(min(lat + TILE_SIZE, GB_MAX_LAT), 2)
                min_lon = round(lon, 2)
                max_lon = round(min(lon + TILE_SIZE, GB_MAX_LON), 2)

                for attempt in range(3):
                    try:
                        data = overpass_query(min_lat, min_lon, max_lat, max_lon)
                        segs = segments_from_ways(data.get("elements", []))
                        store_segments(conn, segs)
                        conn.execute(
                            "INSERT OR IGNORE INTO tiles_fetched (tile_key) VALUES (?)",
                            (tile_key,)
                        )
                        conn.commit()
                        print(f"  ✓ Tile {tile_key}: {len(segs)} segments")
                        time.sleep(1)  # be polite to Overpass
                        break
                    except Exception as e:
                        print(f"  ✗ Tile {tile_key} attempt {attempt+1}: {e}", file=sys.stderr)
                        time.sleep(5 * (attempt + 1))

            done += 1
            lon += TILE_SIZE

        lat += TILE_SIZE

    total_segs = conn.execute("SELECT COUNT(*) FROM track_segments").fetchone()[0]
    total_tiles_done = conn.execute("SELECT COUNT(*) FROM tiles_fetched").fetchone()[0]
    print(f"\nDone: {total_tiles_done} tiles, {total_segs} track segments")
    conn.close()


if __name__ == "__main__":
    if conn := sqlite3.connect(DB_PATH):
        done = conn.execute("SELECT COUNT(*) FROM tiles_fetched").fetchone()[0]
        total = math.ceil((GB_MAX_LAT - GB_MIN_LAT) / TILE_SIZE) * \
                math.ceil((GB_MAX_LON - GB_MIN_LON) / TILE_SIZE)
        conn.close()
        if done >= total * 0.9:  # 90% complete = skip
            print(f"Track DB already built ({done}/{total} tiles), skipping")
            sys.exit(0)

    print(f"Building track geometry DB ({GB_MIN_LAT}–{GB_MAX_LAT}N, {GB_MIN_LON}–{GB_MAX_LON}E)...")
    main()
