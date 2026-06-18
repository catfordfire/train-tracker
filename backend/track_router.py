"""
track_router.py

Routes between stations using GB rail network geometry from
catfordfire/train-tracker/backend/rail_network.json

Data is downloaded at container build time and loaded into SQLite.
No runtime network calls required.
"""

import json
import math
import heapq
import sqlite3
import asyncio
from typing import Optional

DB_PATH = "/data/stations.db"
MAX_ROUTE_KM = 300


def haversine(lat1, lon1, lat2, lon2) -> float:
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1)) * \
        math.cos(math.radians(lat2)) * math.sin(dlon/2)**2
    return R * 2 * math.asin(math.sqrt(a))


# ─── DB setup ─────────────────────────────────────────────────────────────────

def ensure_tables(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS track_segments (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            min_lat REAL, max_lat REAL,
            min_lon REAL, max_lon REAL,
            coords  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_seg_bbox
            ON track_segments(min_lat, max_lat, min_lon, max_lon);

        CREATE TABLE IF NOT EXISTS track_tiplocs (
            tiploc  TEXT PRIMARY KEY,
            crs     TEXT,
            name    TEXT,
            lat     REAL,
            lon     REAL
        );
        CREATE INDEX IF NOT EXISTS idx_tip_crs ON track_tiplocs(crs);

        CREATE TABLE IF NOT EXISTS track_cache (
            from_crs TEXT NOT NULL,
            to_crs   TEXT NOT NULL,
            route    TEXT NOT NULL,
            cached_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (from_crs, to_crs)
        );
    """)
    conn.commit()


def is_network_loaded(conn) -> bool:
    n = conn.execute("SELECT COUNT(*) FROM track_segments").fetchone()[0]
    return n > 0


def load_network_into_db(conn, json_path="/app/rail_network.json"):
    """Parse rail_network.json and insert segments + tiplocs into SQLite."""
    print(f"Loading rail network from {json_path}...")
    with open(json_path) as f:
        data = json.load(f)

    # Insert track segments
    seg_rows = []
    for coords in data.get("segments", []):
        if len(coords) < 2:
            continue
        lats = [c[0] for c in coords]
        lons = [c[1] for c in coords]
        seg_rows.append((min(lats), max(lats), min(lons), max(lons), json.dumps(coords)))

    conn.executemany(
        "INSERT INTO track_segments (min_lat, max_lat, min_lon, max_lon, coords) VALUES (?,?,?,?,?)",
        seg_rows
    )

    # Insert tiplocs
    tip_rows = []
    for tiploc, info in data.get("tiplocs", {}).items():
        tip_rows.append((
            tiploc,
            info.get("crs"),
            info.get("name"),
            info.get("lat"),
            info.get("lon"),
        ))

    conn.executemany(
        "INSERT OR REPLACE INTO track_tiplocs (tiploc, crs, name, lat, lon) VALUES (?,?,?,?,?)",
        tip_rows
    )

    conn.commit()
    segs = conn.execute("SELECT COUNT(*) FROM track_segments").fetchone()[0]
    tips = conn.execute("SELECT COUNT(*) FROM track_tiplocs").fetchone()[0]
    print(f"  Loaded {segs} segments, {tips} tiplocs")


# ─── Routing ──────────────────────────────────────────────────────────────────

def get_cached_route(conn, from_crs, to_crs):
    row = conn.execute(
        "SELECT route FROM track_cache WHERE from_crs=? AND to_crs=?",
        (from_crs, to_crs)
    ).fetchone()
    return json.loads(row[0]) if row else None


def cache_route(conn, from_crs, to_crs, route):
    conn.execute(
        "INSERT OR REPLACE INTO track_cache (from_crs, to_crs, route) VALUES (?,?,?)",
        (from_crs, to_crs, json.dumps(route))
    )
    conn.commit()


def load_segments_bbox(conn, lat1, lon1, lat2, lon2, buffer=None):
    # Dynamic buffer: 15% of straight-line distance in degrees, min 0.15°, max 0.4°
    # 0.15° ~ 11km buffer around each end — enough for most station gaps
    if buffer is None:
        dist_deg = math.sqrt((lat2-lat1)**2 + (lon2-lon1)**2)
        buffer = max(0.15, min(0.4, dist_deg * 0.4))
    min_lat = min(lat1, lat2) - buffer
    max_lat = max(lat1, lat2) + buffer
    min_lon = min(lon1, lon2) - buffer
    max_lon = max(lon1, lon2) + buffer
    rows = conn.execute("""
        SELECT coords FROM track_segments
        WHERE min_lat <= ? AND max_lat >= ?
          AND min_lon <= ? AND max_lon >= ?
    """, (max_lat, min_lat, max_lon, min_lon)).fetchall()
    return [json.loads(r[0]) for r in rows]


def resolve_coords(conn, crs: str, tiplocs: list, fallback_lat, fallback_lon):
    """
    Try to get the best coordinates for a stop:
    1. Match by TIPLOC from track_tiplocs table (most accurate)
    2. Match by CRS from track_tiplocs
    3. Fall back to station DB coords
    """
    # Try each TIPLOC
    for tiploc in tiplocs:
        row = conn.execute(
            "SELECT lat, lon FROM track_tiplocs WHERE tiploc=?", (tiploc.upper(),)
        ).fetchone()
        if row and row[0]:
            return row[0], row[1]

    # Try CRS
    if crs:
        row = conn.execute(
            "SELECT lat, lon FROM track_tiplocs WHERE crs=? LIMIT 1", (crs.upper(),)
        ).fetchone()
        if row and row[0]:
            return row[0], row[1]

    return fallback_lat, fallback_lon


def build_graph(segments, snap_km=0.05):
    """
    Build routing graph, snapping nodes within snap_km of each other
    to the same node ID to bridge gaps between GeoJSON segments.
    """
    nodes = {}
    edges = {}

    # First pass: collect all nodes
    raw_nodes = []
    for coords in segments:
        for lat, lon in coords:
            raw_nodes.append((round(lat, 6), round(lon, 6)))

    # Build snap index: for each node, find if a nearby node already exists
    snap_map = {}  # raw_nid -> canonical_nid
    canonical = []

    for nid in raw_nodes:
        if nid in snap_map:
            continue
        # Check if any existing canonical node is within snap_km
        found = None
        for c in canonical:
            if haversine(nid[0], nid[1], c[0], c[1]) < snap_km:
                found = c
                break
        if found:
            snap_map[nid] = found
        else:
            snap_map[nid] = nid
            canonical.append(nid)

    # Second pass: build graph using snapped node IDs
    for coords in segments:
        way = []
        for lat, lon in coords:
            raw = (round(lat, 6), round(lon, 6))
            nid = snap_map.get(raw, raw)
            nodes[nid] = (nid[0], nid[1])
            way.append(nid)

        for i in range(len(way) - 1):
            a, b = way[i], way[i+1]
            if a == b:
                continue
            d = haversine(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
            edges.setdefault(a, []).append((b, d))
            edges.setdefault(b, []).append((a, d))

    # Bridge small gaps between components (missing track sections in source data)
    # Find connected components and add direct edges across gaps < bridge_km
    bridge_km = 3.0
    visited = set()
    comps = []
    for start in nodes:
        if start not in visited:
            comp = []
            stack = [start]
            while stack:
                n = stack.pop()
                if n in visited:
                    continue
                visited.add(n)
                comp.append(n)
                stack.extend(v for v, _ in edges.get(n, []))
            comps.append(comp)

    if len(comps) > 1:
        # For each pair of components, find closest nodes and bridge if < bridge_km
        for i in range(len(comps)):
            for j in range(i + 1, len(comps)):
                min_d, best_a, best_b = bridge_km + 1, None, None
                # Sample up to 100 nodes per component to avoid O(n^2)
                sample_i = comps[i][:100]
                sample_j = comps[j][:100]
                for a in sample_i:
                    for b in sample_j:
                        d = haversine(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])
                        if d < min_d:
                            min_d, best_a, best_b = d, a, b
                if min_d <= bridge_km and best_a and best_b:
                    edges.setdefault(best_a, []).append((best_b, min_d))
                    edges.setdefault(best_b, []).append((best_a, min_d))

    return nodes, edges


def nearest_node(nodes, lat, lon):
    best, best_d = None, float('inf')
    for nid, (nlat, nlon) in nodes.items():
        d = haversine(lat, lon, nlat, nlon)
        if d < best_d:
            best_d = d
            best = nid
    return best, best_d


def dijkstra(nodes, edges, start, end):
    dist = {start: 0.0}
    prev = {}
    pq = [(0.0, start)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == end:
            path = []
            while u in prev:
                path.append(u)
                u = prev[u]
            path.append(start)
            path.reverse()
            return path
        if d > dist.get(u, float('inf')):
            continue
        for v, w in edges.get(u, []):
            nd = d + w
            if nd < dist.get(v, float('inf')):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))
    return None


def simplify(coords, tol=0.02):
    if len(coords) <= 2:
        return coords

    def pdist(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx-ax, by-ay
        if dx == dy == 0:
            return haversine(p[0], p[1], a[0], a[1])
        t = max(0, min(1, ((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)))
        return haversine(p[0], p[1], ax+t*dx, ay+t*dy)

    dmax, idx = 0, 0
    for i in range(1, len(coords)-1):
        d = pdist(coords[i], coords[0], coords[-1])
        if d > dmax:
            dmax, idx = d, i
    if dmax > tol:
        return simplify(coords[:idx+1], tol)[:-1] + simplify(coords[idx:], tol)
    return [coords[0], coords[-1]]


def filter_segments_by_direction(segs, lat1, lon1, lat2, lon2, tolerance=0.3):
    """
    Keep only segments whose midpoint lies within a corridor around the
    straight line between the two stations.
    tolerance: degrees perpendicular distance allowed from the route line.
    Also keeps segments that are close to either endpoint.
    """
    filtered = []
    # Direction vector
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    length_sq = dlat*dlat + dlon*dlon
    if length_sq == 0:
        return segs

    for seg in segs:
        if not seg:
            continue
        # Use midpoint of segment
        mid_lat = sum(c[0] for c in seg) / len(seg)
        mid_lon = sum(c[1] for c in seg) / len(seg)

        # Project midpoint onto route line
        t = ((mid_lat - lat1) * dlat + (mid_lon - lon1) * dlon) / length_sq
        t = max(0, min(1, t))
        proj_lat = lat1 + t * dlat
        proj_lon = lon1 + t * dlon

        # Perpendicular distance from route line
        perp = math.sqrt((mid_lat - proj_lat)**2 + (mid_lon - proj_lon)**2)

        if perp <= tolerance:
            filtered.append(seg)

    return filtered if filtered else segs  # fallback to all if nothing passes


def route_between_sync(from_crs, from_lat, from_lon, to_crs, to_lat, to_lon,
                       from_tiplocs=None, to_tiplocs=None):
    straight = [[from_lat, from_lon], [to_lat, to_lon]]
    if haversine(from_lat, from_lon, to_lat, to_lon) > MAX_ROUTE_KM:
        return straight

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    try:
        ensure_tables(conn)

        # Load network if needed
        if not is_network_loaded(conn):
            load_network_into_db(conn)

        # Check cache
        cached = get_cached_route(conn, from_crs, to_crs)
        if cached:
            return cached

        # Resolve best coords using TIPLOC data
        a_lat, a_lon = resolve_coords(conn, from_crs, from_tiplocs or [], from_lat, from_lon)
        b_lat, b_lon = resolve_coords(conn, to_crs, to_tiplocs or [], to_lat, to_lon)

        # Load nearby segments
        segs = load_segments_bbox(conn, a_lat, a_lon, b_lat, b_lon)
        if not segs:
            return straight

        # Filter segments to those roughly aligned with direction of travel
        # This reduces node count for long-distance routes without losing the right track
        segs = filter_segments_by_direction(segs, a_lat, a_lon, b_lat, b_lon)
        if not segs:
            return straight

        nodes, edges = build_graph(segs)
        if not nodes:
            return straight

        # If still too large, use a tighter corridor
        if len(nodes) > 6000:
            segs = load_segments_bbox(conn, a_lat, a_lon, b_lat, b_lon, buffer=0.1)
            segs = filter_segments_by_direction(segs, a_lat, a_lon, b_lat, b_lon)
            nodes, edges = build_graph(segs)

        if len(nodes) > 8000:
            print(f"Skipping {from_crs}→{to_crs}: {len(nodes)} nodes still too large")
            return straight

        sn, sd = nearest_node(nodes, a_lat, a_lon)
        en, ed = nearest_node(nodes, b_lat, b_lon)

        if sd > 1.5 or ed > 1.5:
            return straight

        path = dijkstra(nodes, edges, sn, en)
        if not path:
            return straight

        coords = [[from_lat, from_lon]] +                  [[nodes[n][0], nodes[n][1]] for n in path] +                  [[to_lat, to_lon]]

        # Sanity check: reject if routed distance > 3x straight-line
        straight_km = haversine(from_lat, from_lon, to_lat, to_lon)
        routed_km = sum(
            haversine(coords[i][0], coords[i][1], coords[i+1][0], coords[i+1][1])
            for i in range(len(coords)-1)
        )
        if routed_km > straight_km * 3.5:
            print(f"Route {from_crs}→{to_crs} rejected: {routed_km:.1f}km vs {straight_km:.1f}km straight")
            return straight

        result = simplify(coords, tol=0.02)

        if len(result) > 3:
            cache_route(conn, from_crs, to_crs, result)

        return result

    except Exception as e:
        print(f"Track routing error ({from_crs}→{to_crs}): {e}")
        return straight
    finally:
        conn.close()


async def route_between(from_crs, from_lat, from_lon, to_crs, to_lat, to_lon,
                        from_tiplocs=None, to_tiplocs=None):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, route_between_sync,
        from_crs, from_lat, from_lon,
        to_crs, to_lat, to_lon,
        from_tiplocs, to_tiplocs,
    )


async def route_full_service(locations: list) -> list:
    mapped = [(i, loc) for i, loc in enumerate(locations)
              if loc.get("lat") and loc.get("lon")]
    if len(mapped) < 2:
        return [[loc["lat"], loc["lon"]] for _, loc in mapped]

    full_route = []
    for i in range(len(mapped) - 1):
        _, a = mapped[i]
        _, b = mapped[i+1]
        from_crs = (a.get("location", {}).get("shortCodes") or ["??"])[0]
        to_crs   = (b.get("location", {}).get("shortCodes") or ["??"])[0]
        from_tip = a.get("location", {}).get("longCodes") or []
        to_tip   = b.get("location", {}).get("longCodes") or []

        try:
            seg = await asyncio.wait_for(
                route_between(
                    from_crs, a["lat"], a["lon"],
                    to_crs,   b["lat"], b["lon"],
                    from_tiplocs=from_tip,
                    to_tiplocs=to_tip,
                ),
                timeout=10.0  # 10s per segment max
            )
        except asyncio.TimeoutError:
            print(f"Timeout routing {from_crs}→{to_crs}, using straight line")
            seg = [[a["lat"], a["lon"]], [b["lat"], b["lon"]]]

        if not full_route:
            full_route.extend(seg)
        else:
            full_route.extend(seg[1:])

    return full_route


# ─── Debug helper (remove in production) ──────────────────────────────────────
