import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Polyline, Marker, Popup, CircleMarker, useMap } from 'react-leaflet';
import L from 'leaflet';
import './App.css';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const API_BASE = (typeof __API_URL__ !== 'undefined' && __API_URL__) ? __API_URL__ : '';
const REFRESH_INTERVAL = 30_000;

const STADIA_KEY = (typeof __STADIA_API_KEY__ !== 'undefined' && __STADIA_API_KEY__) ? __STADIA_API_KEY__ : '';

const MAP_TILES = {
  dark: {
    label: '🌑 Dark',
    url: `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png${STADIA_KEY ? '?api_key=' + STADIA_KEY : ''}`,
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  light: {
    label: '☀️ Light',
    url: `https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png${STADIA_KEY ? '?api_key=' + STADIA_KEY : ''}`,
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  },
  satellite: {
    label: '🛰️ Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri',
  },
};

// ─── localStorage helpers ─────────────────────────────────────────────────────

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtISO(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function delayMins(td, type) {
  return td?.[type]?.realtimeAdvertisedLateness ?? null;
}

function locationStatus(loc) {
  const status = loc.temporalData?.status;
  if (!status) return null;
  const map = {
    'APPROACHING': { label: 'Approaching',       colour: '#f59e0b', pulse: true  },
    'AT_PLATFORM': { label: 'At platform',        colour: '#22c55e', pulse: true  },
    'DEPARTED':    { label: 'Departed',            colour: '#94a3b8', pulse: false },
    'APPR_STAT':   { label: 'Approaching',         colour: '#f59e0b', pulse: true  },
    'APPR_PLAT':   { label: 'Arriving',            colour: '#fbbf24', pulse: true  },
    'AT_PLAT':     { label: 'At platform',         colour: '#22c55e', pulse: true  },
    'DEP_PREP':    { label: 'Preparing to depart', colour: '#a78bfa', pulse: true  },
    'DEP_READY':   { label: 'Ready to depart',     colour: '#818cf8', pulse: true  },
  };
  return map[status] || { label: status, colour: '#94a3b8', pulse: false };
}

function stopColour(loc) {
  const arr = loc.temporalData?.arrival;
  const dep = loc.temporalData?.departure;
  const pass = loc.temporalData?.pass;
  const displayAs = loc.temporalData?.displayAs;

  if (arr?.isCancelled || dep?.isCancelled) return '#ef4444';
  if (displayAs === 'CANCELLED_CALL' || displayAs === 'CANCELLED_PASS') return '#ef4444';

  // Detailed mode: live signal status
  const st = locationStatus(loc);
  if (st?.pulse) return st.colour;

  // Departed/passed
  if (dep?.realtimeActual || arr?.realtimeActual || pass?.realtimeActual) return '#22c55e';

  // Late via advertised lateness
  const delay = dep?.realtimeAdvertisedLateness ?? arr?.realtimeAdvertisedLateness;
  if (delay !== null && delay !== undefined) {
    if (delay > 3) return '#f59e0b';
    if (delay <= 0) return '#22c55e';
  }

  // Forecast available (detailed mode) — compare forecast to schedule
  const forecast = dep?.realtimeForecast || arr?.realtimeForecast || pass?.realtimeForecast;
  const sched = dep?.scheduleAdvertised || arr?.scheduleAdvertised || pass?.scheduleAdvertised;
  if (forecast && sched) {
    const lateMs = new Date(forecast) - new Date(sched);
    const lateMins = lateMs / 60000;
    if (lateMins > 3) return '#f59e0b';
    if (lateMins <= 0) return '#34d399'; // forecast on time/early — light green
    return '#fbbf24'; // slightly late forecast
  }

  // Due: scheduled time has passed
  if (sched && new Date(sched) <= new Date()) return '#f59e0b';

  return '#94a3b8';
}

function isPass(loc) {
  const displayAs = loc.temporalData?.displayAs;
  if (displayAs) return displayAs === 'PASS' || displayAs === 'CANCELLED_PASS';
  // Fallback: no arrival or departure timing, only pass
  return !loc.temporalData?.arrival && !loc.temporalData?.departure && !!loc.temporalData?.pass;
}

function journeyProgress(locations) {
  const pub = locations.filter(l => !isPass(l));
  if (!pub.length) return null;
  const departed = pub.filter(l => {
    return l.temporalData?.departure?.realtimeActual || l.temporalData?.arrival?.realtimeActual;
  }).length;
  return { departed, total: pub.length, pct: Math.round((departed / pub.length) * 100) };
}

function estimatePosition(locations) {
  // Filter to only locations with valid numeric coordinates
  const valid = locations.filter(l =>
    typeof l.lat === 'number' && typeof l.lon === 'number' &&
    isFinite(l.lat) && isFinite(l.lon)
  );
  if (!valid.length) return null;

  // ── Priority 1: Signal status (detailed mode) ─────────────────────────────
  for (let i = 0; i < valid.length; i++) {
    const loc = valid[i];
    const status = loc.temporalData?.status;
    if (!status) continue;
    const prev = i > 0 ? valid[i - 1] : null;

    if (status === 'APPROACHING' || status === 'APPR_STAT') {
      if (prev) return {
        lat: prev.lat + (loc.lat - prev.lat) * 0.75,
        lon: prev.lon + (loc.lon - prev.lon) * 0.75,
        label: `Approaching ${loc.location?.description}`,
      };
      return { lat: loc.lat, lon: loc.lon, label: `Approaching ${loc.location?.description}` };
    }
    if (status === 'APPR_PLAT') {
      if (prev) return {
        lat: prev.lat + (loc.lat - prev.lat) * 0.95,
        lon: prev.lon + (loc.lon - prev.lon) * 0.95,
        label: `Arriving at ${loc.location?.description}`,
      };
      return { lat: loc.lat, lon: loc.lon, label: `Arriving at ${loc.location?.description}` };
    }
    if (status === 'AT_PLAT' || status === 'AT_PLATFORM') {
      return { lat: loc.lat, lon: loc.lon, label: `At ${loc.location?.description}` };
    }
    if (status === 'DEP_PREP' || status === 'DEP_READY') {
      return { lat: loc.lat, lon: loc.lon, label: `Departing ${loc.location?.description}` };
    }
  }

  // ── Priority 2: Time-based interpolation ──────────────────────────────────
  let lastDep = null, nextArr = null;
  for (const loc of valid) {
    const td = loc.temporalData;
    const acted = td?.departure?.realtimeActual
               || td?.pass?.realtimeActual
               || td?.arrival?.realtimeActual;
    if (acted) {
      lastDep = loc;
    } else if (!nextArr && lastDep) {
      nextArr = loc;
    }
  }

  if (!lastDep) return { lat: valid[0].lat, lon: valid[0].lon, label: 'At origin' };
  if (!nextArr) return { lat: lastDep.lat, lon: lastDep.lon, label: 'At terminus' };

  const ltd = lastDep.temporalData;
  const ntd = nextArr.temporalData;

  const depStr = ltd?.departure?.realtimeActual
    || ltd?.pass?.realtimeActual
    || ltd?.departure?.realtimeForecast
    || ltd?.departure?.scheduleInternal
    || ltd?.pass?.realtimeForecast
    || ltd?.pass?.scheduleInternal;

  const arrStr = ntd?.arrival?.realtimeForecast
    || ntd?.arrival?.scheduleInternal
    || ntd?.pass?.realtimeForecast
    || ntd?.pass?.scheduleInternal
    || ntd?.arrival?.scheduleAdvertised
    || ntd?.pass?.scheduleAdvertised;

  if (!depStr || !arrStr) {
    return { lat: lastDep.lat, lon: lastDep.lon, label: `Left ${lastDep.location?.description}` };
  }

  const depTime = new Date(depStr);
  const arrTime = new Date(arrStr);

  if (isNaN(depTime.getTime()) || isNaN(arrTime.getTime()) || arrTime <= depTime) {
    return { lat: lastDep.lat, lon: lastDep.lon, label: `Left ${lastDep.location?.description}` };
  }

  const frac = Math.min(1, Math.max(0, (Date.now() - depTime) / (arrTime - depTime)));
  const lat = lastDep.lat + (nextArr.lat - lastDep.lat) * frac;
  const lon = lastDep.lon + (nextArr.lon - lastDep.lon) * frac;

  if (isNaN(lat) || isNaN(lon)) return null;

  return {
    lat, lon,
    label: `Between ${lastDep.location?.description} → ${nextArr.location?.description}`,
  };
}


function safePosition(pos) {
  if (!pos) return null;
  if (isNaN(pos.lat) || isNaN(pos.lon)) return null;
  if (!isFinite(pos.lat) || !isFinite(pos.lon)) return null;
  return pos;
}

const trainIcon = (colour = '#60a5fa') => L.divIcon({
  html: `<div class="train-icon" style="filter:drop-shadow(0 0 6px ${colour})">🚂</div>`,
  className: '', iconSize: [32,32], iconAnchor: [16,16],
});

// ─── Map tile switcher ────────────────────────────────────────────────────────

function TileLayerSwitcher({ tileKey }) {
  const t = MAP_TILES[tileKey];
  return <TileLayer attribution={t.attribution} url={t.url} />;
}

function MapFitter({ positions, fitKey }) {
  const map = useMap();
  const lastFitKey = useRef(null);
  useEffect(() => {
    if (positions?.length > 1 && fitKey !== lastFitKey.current) {
      lastFitKey.current = fitKey;
      map.fitBounds(L.latLngBounds(positions), { padding: [40,40] });
    }
  }, [map, positions, fitKey]);
  return null;
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

function StationAutocomplete({ label, placeholder, value, onChange, onSelect }) {
  const [suggestions, setSuggestions] = useState([]);
  const wrapRef = useRef(null);
  useEffect(() => {
    const h = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setSuggestions([]); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const handleChange = async (e) => {
    const v = e.target.value; onChange(v);
    if (v.length < 2) { setSuggestions([]); return; }
    const res = await fetch(`${API_BASE}/api/stations/search?q=${encodeURIComponent(v)}`);
    if (res.ok) setSuggestions(await res.json());
  };
  return (
    <div className="autocomplete-wrap" ref={wrapRef}>
      <div className="search-group">
        <label>{label}</label>
        <input className="input" placeholder={placeholder} value={value} onChange={handleChange} />
      </div>
      {suggestions.length > 0 && (
        <ul className="suggestions">
          {suggestions.map(s => (
            <li key={s.crs} onClick={() => { onSelect(s); setSuggestions([]); }}>
              {s.name} <span className="sug-crs">{s.crs}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Calling points ───────────────────────────────────────────────────────────

function CallingPoints({ uid, depDate, onClose, onSelect }) {
  const [stops, setStops] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(`${API_BASE}/api/service/${uid}?run_date=${depDate}`)
      .then(r => r.json()).then(d => setStops(d?.service?.locations || []))
      .catch(() => setStops([])).finally(() => setLoading(false));
  }, [uid, depDate]);

  return (
    <div className="calling-points">
      <div className="cp-header"><span>Calling points</span><button className="cp-close" onClick={onClose}>✕</button></div>
      {loading && <div className="cp-loading">Loading…</div>}
      {stops && stops.filter(l => !isPass(l)).map((loc, i) => {
        const dep = loc.temporalData?.departure;
        const arr = loc.temporalData?.arrival;
        const sched = fmtISO(dep?.scheduleAdvertised || arr?.scheduleAdvertised);
        const rt = fmtISO(dep?.realtimeActual || dep?.realtimeEstimate || arr?.realtimeActual || arr?.realtimeEstimate);
        const delay = dep?.realtimeAdvertisedLateness ?? arr?.realtimeAdvertisedLateness ?? null;
        const cancelled = dep?.isCancelled || arr?.isCancelled;
        const platform = loc.locationMetadata?.platform?.actual || loc.locationMetadata?.platform?.planned;
        const st = locationStatus(loc);
        return (
          <div key={i} className="cp-stop">
            <div className="cp-dot" style={{ background: stopColour(loc) }} />
            <div className="cp-name">
              {loc.location?.description}
              {st?.pulse && <span className="cp-status-badge" style={{ background: st.colour + '22', color: st.colour }}>{st.label}</span>}
            </div>
            <div className="cp-times">
              <span className="cp-sched">{sched}</span>
              {rt && rt !== sched && <span className={`cp-rt ${delay > 0 ? 'late' : delay < 0 ? 'early' : 'ontime'}`}>{rt}{delay !== null && delay !== 0 && ` (${delay > 0 ? '+' : ''}${delay})`}</span>}
              {cancelled && <span className="cp-canc">CANC</span>}
              {platform && <span className="cp-plat">Pl {platform}</span>}
            </div>
          </div>
        );
      })}
      <button className="btn-primary cp-track" onClick={() => { onSelect(uid, depDate); onClose(); }}>Track on map →</button>
    </div>
  );
}

// ─── Favourites ───────────────────────────────────────────────────────────────

function FavouriteStar({ uid, name, onLoad }) {
  const [favs, setFavs] = useState(() => lsGet('tt_favs', []));
  const isFav = favs.some(f => f.uid === uid);
  const toggle = () => {
    const next = isFav ? favs.filter(f => f.uid !== uid) : [...favs, { uid, name, added: new Date().toISOString() }];
    setFavs(next); lsSet('tt_favs', next);
  };
  return (
    <button className={`fav-star ${isFav ? 'active' : ''}`} onClick={toggle} title={isFav ? 'Remove favourite' : 'Save as favourite'}>
      {isFav ? '★' : '☆'}
    </button>
  );
}

function FavouritesList({ onLoad }) {
  const [favs, setFavs] = useState(() => lsGet('tt_favs', []));
  const [, forceRender] = useState(0);
  const remove = (uid) => {
    const next = favs.filter(f => f.uid !== uid);
    setFavs(next); lsSet('tt_favs', next); forceRender(n => n+1);
  };
  if (!favs.length) return <div className="no-results">No saved services yet — track a train and tap ☆ to save it</div>;
  return (
    <div className="favs-list">
      {favs.map(f => (
        <div key={f.uid} className="fav-row">
          <div className="fav-info">
            <span className="fav-name">{f.name}</span>
            <span className="fav-uid">{f.uid}</span>
          </div>
          <div className="fav-actions">
            <button className="btn-sm" onClick={() => onLoad(f.uid, new Date().toISOString().slice(0,10))}>Track today</button>
            <button className="fav-remove" onClick={() => remove(f.uid)}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Rolling stock display ────────────────────────────────────────────────────

function RollingStock({ service }) {
  const allocs = service?.allocationData;
  if (!allocs?.length) return null;
  const a = allocs[0];
  const units = a.allocationItems?.map(i => i.identity).filter(Boolean).join(' + ') || '—';
  const cls = a.leadingClass ? `Class ${a.leadingClass}` : '';
  const coaches = a.passengerVehicles || '?';
  const branding = a.knowYourTrainData?.stockBranding;
  return (
    <div className="rolling-stock">
      <span className="rs-icon">🚃</span>
      {cls && <span className="rs-class">{cls}</span>}
      <span className="rs-coaches">{coaches} coaches</span>
      {units !== '—' && <span className="rs-units">{units}</span>}
      {branding && <span className="rs-branding">{branding}</span>}
    </div>
  );
}

// ─── Delay reasons ────────────────────────────────────────────────────────────

function DelayReasons({ service }) {
  const reasons = service?.reasons;
  if (!reasons?.length) return null;
  return (
    <div className="delay-reasons">
      {reasons.map((r, i) => (
        <div key={i} className="delay-reason">
          <span className="dr-icon">⚠</span>
          <span className="dr-text">{r.shortText || r.longText}</span>
          <span className="dr-code">{r.code}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Journey progress bar ─────────────────────────────────────────────────────

function JourneyProgress({ locations }) {
  const prog = journeyProgress(locations);
  if (!prog) return null;
  const activeLoc = locations.find(l => locationStatus(l)?.pulse);
  const activeStatus = activeLoc ? locationStatus(activeLoc) : null;
  return (
    <div className="journey-progress">
      <div className="jp-bar-wrap">
        <div className="jp-bar" style={{ width: `${prog.pct}%` }} />
        {activeStatus && (
          <div className="jp-marker" style={{ left: `${prog.pct}%`, background: activeStatus.colour }}>
            <div className="jp-pulse" style={{ background: activeStatus.colour }} />
          </div>
        )}
      </div>
      <div className="jp-labels">
        <span>{prog.departed} of {prog.total} stops</span>
        {activeStatus && activeLoc && <span className="jp-active" style={{ color: activeStatus.colour }}>● {activeStatus.label}: {activeLoc.location?.description}</span>}
        <span>{prog.pct}%</span>
      </div>
    </div>
  );
}

// ─── Departure board ──────────────────────────────────────────────────────────

function DepartureBoard({ onSelectService, savedState, onSaveState }) {
  const s = savedState || {};
  const [origin, setOrigin] = useState(s.origin || '');
  const [originCode, setOriginCode] = useState(s.originCode || '');
  const [dest, setDest] = useState(s.dest || '');
  const [destCode, setDestCode] = useState(s.destCode || '');
  const [date, setDate] = useState(s.date || new Date().toISOString().slice(0,10));
  const [time, setTime] = useState(s.time || (() => { const n = new Date(); return `${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}`; })());
  const [results, setResults] = useState(s.results || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const timerRef = useRef(null);

  // Persist state upward whenever key fields change
  useEffect(() => {
    onSaveState({ origin, originCode, dest, destCode, date, time, results });
  }, [origin, originCode, dest, destCode, date, time, results]); // eslint-disable-line

  const doSearch = useCallback(async (code, d, t, dCode) => {
    if (!code) return;
    setLoading(true); setError(null);
    try {
      let url = `${API_BASE}/api/station/${code}?run_date=${d}&time=${t}&window=120`;
      if (dCode) url += `&filter_to=${dCode}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json().catch(()=>({}))).detail || 'Error');
      const data = await res.json();
      setResults(data.services || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (!originCode) { setError('Select a valid origin station'); return; }
    setExpandedIdx(null);
    doSearch(originCode, date, time, destCode);
  };

  useEffect(() => {
    clearInterval(timerRef.current);
    if (autoRefresh && originCode) timerRef.current = setInterval(() => doSearch(originCode, date, time, destCode), 30_000);
    return () => clearInterval(timerRef.current);
  }, [autoRefresh, originCode, date, time, destCode, doSearch]);

  return (
    <div className="station-search">
      <form className="station-form" onSubmit={handleSearch}>
        <StationAutocomplete label="From" placeholder="e.g. Shrewsbury" value={origin}
          onChange={v => { setOrigin(v); setOriginCode(''); }}
          onSelect={s => { setOrigin(s.name); setOriginCode(s.crs); }} />
        <StationAutocomplete label="To (optional)" placeholder="e.g. Birmingham" value={dest}
          onChange={v => { setDest(v); setDestCode(''); }}
          onSelect={s => { setDest(s.name); setDestCode(s.crs); }} />
        <div className="search-group">
          <label>Date</label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="search-group">
          <label>From time</label>
          <input type="time" className="input" value={`${time.slice(0,2)}:${time.slice(2,4)}`}
            onChange={e => setTime(e.target.value.replace(':',''))} />
        </div>
        <div className="board-actions">
          <button type="submit" className="btn-primary" disabled={loading}>{loading ? '…' : 'Search'}</button>
          {results && <label className="auto-refresh-toggle"><input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />Auto-refresh</label>}
        </div>
      </form>

      {error && <div className="search-error">⚠ {error}</div>}
      {results && results.length === 0 && <div className="no-results">No services found</div>}

      {results && results.length > 0 && (
        <div className="service-results">
          <div className="board-header"><span>Dep</span><span>Destination</span><span className="bh-right">Pl / Status</span></div>
          {results.map((svc, i) => {
            const meta = svc.scheduleMetadata;
            const td = svc.temporalData;
            const dep = td?.departure;
            const delay = dep?.realtimeAdvertisedLateness;
            const destName = svc.destination?.[0]?.location?.description || '?';
            const uid = meta?.identity;
            const depDate = meta?.departureDate;
            const platform = svc.locationMetadata?.platform?.actual || svc.locationMetadata?.platform?.planned;
            const cancelled = dep?.isCancelled;
            const isExpanded = expandedIdx === i;
            const hasRt = dep?.realtimeActual || dep?.realtimeEstimate;
            const st = locationStatus(svc);
            return (
              <div key={i} className={`board-row ${cancelled ? 'cancelled' : ''}`}>
                <div className="board-row-main" onClick={() => setExpandedIdx(isExpanded ? null : i)}>
                  <div className="sr-time">
                    <span className="sr-sched">{fmtISO(dep?.scheduleAdvertised)}</span>
                    {hasRt && <span className={`sr-rt ${delay > 0 ? 'late' : delay < 0 ? 'early' : 'ontime'}`}>
                      {fmtISO(dep.realtimeActual || dep.realtimeEstimate)}
                      {delay !== null && delay !== 0 && <span className="delay-badge">{delay > 0 ? `+${delay}` : delay}</span>}
                    </span>}
                  </div>
                  <div className="sr-info">
                    <span className="sr-dest">→ {destName}</span>
                    <span className="sr-op">{meta?.operator?.name} · {meta?.trainReportingIdentity}</span>
                  </div>
                  <div className="sr-right">
                    {platform && <span className="platform">Pl {platform}</span>}
                    {cancelled ? <span className="cancelled-badge">CANC</span>
                      : st?.pulse ? <span className="status-badge" style={{ color: st.colour }}>{st.label}</span>
                      : delay > 3 ? <span className="status-late">Late</span>
                      : hasRt ? <span className="status-ontime">On time</span>
                      : null}
                    <span className="expand-arrow">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>
                {isExpanded && <CallingPoints uid={uid} depDate={depDate} onClose={() => setExpandedIdx(null)} onSelect={onSelectService} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Headcode search ──────────────────────────────────────────────────────────

function HeadcodeSearch({ onSelectService }) {
  const [headcode, setHeadcode] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const handleSearch = async (e) => {
    e.preventDefault();
    if (!headcode.trim()) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/headcode/${headcode.trim().toUpperCase()}?run_date=${date}`);
      if (!res.ok) throw new Error('Lookup failed');
      const data = await res.json();
      if (!data.found) throw new Error(`Headcode ${headcode.toUpperCase()} not found for ${date}`);
      setResult(data);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  return (
    <div className="station-search">
      <form className="station-form" onSubmit={handleSearch}>
        <div className="search-group"><label>Headcode</label>
          <input className="input" placeholder="e.g. 1J54" value={headcode} onChange={e => setHeadcode(e.target.value)} spellCheck={false} maxLength={4} />
        </div>
        <div className="search-group"><label>Date</label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Searching…' : 'Find'}</button>
      </form>
      {loading && <div className="loading-state hc-loading">Searching across stations…<br/><span className="hc-hint">This may take a few seconds</span></div>}
      {error && <div className="search-error">⚠ {error}</div>}
      {result && (
        <div className="hc-result">
          <div className="hc-headcode">{result.trainReportingIdentity}</div>
          <div className="hc-route">{result.origin} → {result.destination}</div>
          <div className="hc-meta">{result.operator} · UID: {result.identity}</div>
          <button className="btn-primary hc-track" onClick={() => onSelectService(result.identity, result.departureDate)}>Track on map →</button>
        </div>
      )}
    </div>
  );
}

// ─── Stop list ────────────────────────────────────────────────────────────────


// ─── Connections Panel ────────────────────────────────────────────────────────

function ConnectionsPanel({ stop, arrivalISO, destCode, destName, onSelectService, onClose, leg }) {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [nextLeg, setNextLeg] = useState(null);

  const crs = stop.location?.shortCodes?.[0];
  const stationName = stop.location?.description;

  // If we're AT the destination, clear the filter — show all onward connections
  const isAtDest = destCode && crs === destCode;
  const effectiveDestCode = isAtDest ? null : destCode;
  const effectiveDestName = isAtDest ? null : destName;

  useEffect(() => {
    if (!crs) { setError('No CRS code for this stop'); setLoading(false); return; }

    const fromTime = arrivalISO ? new Date(arrivalISO) : new Date();
    const date = fromTime.toISOString().slice(0, 10);
    const time = `${String(fromTime.getHours()).padStart(2,'0')}${String(fromTime.getMinutes()).padStart(2,'0')}`;

    let url = `${API_BASE}/api/station/${crs}?run_date=${date}&time=${time}&window=120`;
    if (effectiveDestCode) url += `&filter_to=${effectiveDestCode}`;

    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => {
          const svcs = d.services || [];
          // Filter out services terminating AT this station
          // API returns longCodes (TIPLOCs) not shortCodes in destination
          const filtered = svcs.filter(svc => {
            const destDesc = svc.destination?.[0]?.location?.description || '';
            const destShort = svc.destination?.[0]?.location?.shortCodes?.[0];
            // Filter if destination CRS matches (when available)
            if (destShort && destShort === crs) return false;
            // Filter if destination description matches station name
            if (destDesc === stop.location?.description) return false;
            return true;
          });
          setServices(filtered);
        })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [crs, arrivalISO, destCode]);

  if (nextLeg) {
    return (
      <ConnectionsPanel
        stop={nextLeg.stop}
        arrivalISO={nextLeg.arrivalISO}
        destCode={effectiveDestCode}
        destName={effectiveDestName}
        onSelectService={onSelectService}
        onClose={onClose}
        leg={leg + 1}
      />
    );
  }

  return (
    <div className="connections-panel">
      <div className="conn-header">
        <div className="conn-title">
          <span className="conn-leg">Leg {leg}</span>
          <span className="conn-station">Connections at {stationName}</span>
          {effectiveDestName && <span className="conn-dest">→ {effectiveDestName}</span>}
          {isAtDest && <span className="conn-dest" style={{color:'#94a3b8'}}>All onward services</span>}
        </div>
        <button className="cp-close" onClick={onClose}>✕</button>
      </div>

      {loading && <div className="conn-loading">Loading connections…</div>}
      {error && <div className="conn-error">⚠ {error}</div>}
      {services && services.length === 0 && (
        <div className="conn-empty">No connections found{effectiveDestName ? ` towards ${effectiveDestName}` : ''}</div>
      )}

      {services && services.map((svc, i) => {
        const meta = svc.scheduleMetadata;
        const dep = svc.temporalData?.departure;
        const arr = svc.temporalData?.arrival;
        // Use departure if available, fall back to arrival (pass/arrival-only stops)
        const td = dep?.scheduleAdvertised ? dep : arr;
        const delay = td?.realtimeAdvertisedLateness;
        const cancelled = td?.isCancelled;
        const hasRt = td?.realtimeActual || td?.realtimeEstimate;
        const platform = svc.locationMetadata?.platform?.actual || svc.locationMetadata?.platform?.planned;
        const destLoc = svc.destination?.[0]?.location?.description || '?';
        const uid = meta?.identity;
        const depDate = meta?.departureDate;
        const isExpanded = expandedIdx === i;

        return (
          <div key={i} className={`conn-service ${cancelled ? 'cancelled' : ''}`}>
            <div className="conn-service-main" onClick={() => setExpandedIdx(isExpanded ? null : i)}>
              <div className="sr-time">
                <span className="sr-sched">{fmtISO(td?.scheduleAdvertised)}</span>
                {hasRt && (
                  <span className={`sr-rt ${delay > 0 ? 'late' : delay < 0 ? 'early' : 'ontime'}`}>
                    {fmtISO(td.realtimeActual || td.realtimeEstimate)}
                    {delay !== null && delay !== 0 && <span className="delay-badge">{delay > 0 ? `+${delay}` : delay}</span>}
                  </span>
                )}
              </div>
              <div className="sr-info">
                <span className="sr-dest">→ {destLoc}</span>
                <span className="sr-op">{meta?.operator?.name} · {meta?.trainReportingIdentity}</span>
              </div>
              <div className="sr-right">
                {platform && <span className="platform">Pl {platform}</span>}
                {cancelled
                  ? <span className="cancelled-badge">CANC</span>
                  : delay !== null && delay !== undefined
                    ? delay > 0
                      ? <span className="conn-delay-badge late">+{delay}m late</span>
                      : delay < 0
                        ? <span className="conn-delay-badge early">{Math.abs(delay)}m early</span>
                        : <span className="conn-delay-badge ontime">On time</span>
                    : hasRt
                      ? <span className="conn-delay-badge ontime">On time</span>
                      : <span className="conn-delay-badge sched">Sched</span>}
                <span className="expand-arrow">{isExpanded ? '▲' : '▼'}</span>
              </div>
            </div>

            {isExpanded && (
              <ConnServiceDetail
                uid={uid}
                depDate={depDate}
                destCode={effectiveDestCode}
                destName={effectiveDestName}
                leg={leg}
                onTrack={() => { onSelectService(uid, depDate); onClose(); }}
                onNextLeg={(stop, arrivalISO) => setNextLeg({ stop, arrivalISO })}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConnServiceDetail({ uid, depDate, destCode, destName, leg, onTrack, onNextLeg }) {
  const [stops, setStops] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/service/${uid}?run_date=${depDate}`)
      .then(r => r.json())
      .then(d => setStops(d?.service?.locations || []))
      .catch(() => setStops([]))
      .finally(() => setLoading(false));
  }, [uid, depDate]);

  if (loading) return <div className="cp-loading">Loading calling points…</div>;

  const publicStops = (stops || []).filter(l => !isPass(l));

  return (
    <div className="conn-detail">
      <div className="conn-detail-stops">
        {publicStops.map((loc, i) => {
          const dep = loc.temporalData?.departure;
          const arr = loc.temporalData?.arrival;
          const sched = fmtISO(dep?.scheduleAdvertised || arr?.scheduleAdvertised);
          const rt = fmtISO(dep?.realtimeActual || dep?.realtimeEstimate || arr?.realtimeActual || arr?.realtimeEstimate);
          const delay = dep?.realtimeAdvertisedLateness ?? arr?.realtimeAdvertisedLateness ?? null;
          const platform = loc.locationMetadata?.platform?.actual || loc.locationMetadata?.platform?.planned;
          const crs = loc.location?.shortCodes?.[0];
          const arrISO = arr?.realtimeActual || arr?.realtimeEstimate || arr?.scheduleAdvertised;
          const isDestination = crs && destCode && crs === destCode;

          return (
            <div key={i} className={`cp-stop ${isDestination ? 'cp-destination' : ''}`}>
              <div className="cp-dot" style={{ background: stopColour(loc) }} />
              <div className="cp-name">
                {loc.location?.description}
                {isDestination && <span className="conn-dest-badge">Your destination</span>}
              </div>
              <div className="cp-times">
                <span className="cp-sched">{sched}</span>
                {rt && rt !== sched && (
                  <span className={`cp-rt ${delay > 0 ? 'late' : delay < 0 ? 'early' : 'ontime'}`}>
                    {rt}{delay !== null && delay !== 0 && ` (${delay > 0 ? '+' : ''}${delay})`}
                  </span>
                )}
                {platform && <span className="cp-plat">Pl {platform}</span>}
                {/* Show "connect here" button for intermediate stops if under leg limit */}
                {leg < 3 && crs && arrISO && !isDestination && i > 0 && (
                  <button className="btn-connect" onClick={() => onNextLeg(loc, arrISO)}>
                    🔗 Connect
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn-primary cp-track" onClick={onTrack}>Track on map →</button>
    </div>
  );
}

function StopList({ locations, activeStop, onSelect, onConnect, activeConn }) {
  const listRef = useRef(null);
  useEffect(() => {
    if (activeStop != null && listRef.current) {
      const el = listRef.current.querySelector(`[data-idx="${activeStop}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeStop]);
  return (
    <div className="stop-list" ref={listRef}>
      {locations.map((loc, i) => {
        if (isPass(loc)) return null;
        const colour = stopColour(loc);
        const isActive = activeStop === i;
        const isConnActive = activeConn === i;
        const td = loc.temporalData;
        const dep = td?.departure; const arr = td?.arrival;
        const schedTime = dep?.scheduleAdvertised || arr?.scheduleAdvertised;
        const rtTime = dep?.realtimeActual || dep?.realtimeEstimate || arr?.realtimeActual || arr?.realtimeEstimate
                    || dep?.realtimeForecast || arr?.realtimeForecast;
        const isForecast = !dep?.realtimeActual && !arr?.realtimeActual && (dep?.realtimeForecast || arr?.realtimeForecast);
        const delay = delayMins(td, dep ? 'departure' : 'arrival') ??
          (() => {
            const fc = dep?.realtimeForecast || arr?.realtimeForecast;
            const sc = dep?.scheduleAdvertised || arr?.scheduleAdvertised;
            if (fc && sc) return Math.round((new Date(fc) - new Date(sc)) / 60000);
            return null;
          })();
        const platform = loc.locationMetadata?.platform?.actual || loc.locationMetadata?.platform?.planned;
        const st = locationStatus(loc);
        // Show connect button on upcoming stops (no actual time yet)
        const isUpcoming = !dep?.realtimeActual && !arr?.realtimeActual;
        const crs = loc.location?.shortCodes?.[0];
        // Arrival time for connection timing
        const arrISO = arr?.realtimeActual || arr?.realtimeEstimate || arr?.scheduleAdvertised
                    || dep?.realtimeActual || dep?.realtimeEstimate || dep?.scheduleAdvertised;
        return (
          <div key={i} data-idx={i}
            className={`stop-row ${isActive ? 'active' : ''} ${loc.lat ? '' : 'no-coords'} ${st?.pulse ? 'stop-active' : ''} ${isConnActive ? 'conn-active' : ''}`}
            onClick={() => onSelect(i)} style={{ borderLeftColor: colour }}>
            <div className={`stop-dot ${st?.pulse ? 'dot-pulse' : ''}`} style={{ background: colour }} />
            <div className="stop-info">
              <span className="stop-name">{loc.location?.description || '?'}</span>
              {st?.pulse ? <span className="stop-status-label" style={{ color: st.colour }}>{st.label}</span>
                : <span className="stop-crs">{loc.location?.shortCodes?.[0] || ''}</span>}
            </div>
            <div className="stop-times">
              <span className="sched">{fmtISO(schedTime)}</span>
              {rtTime && <span className={`rt ${delay > 0 ? 'late' : delay < 0 ? 'early' : 'ontime'}`}>
                {fmtISO(rtTime)}{isForecast && <span className="forecast-label">est</span>}
                {delay !== null && delay !== 0 && <span className="delay-badge">{delay > 0 ? `+${delay}` : delay}</span>}
              </span>}
              {platform && <span className="platform">Pl {platform}</span>}
              {isUpcoming && crs && onConnect && (
                <button className={`btn-conn-stop ${isConnActive ? 'active' : ''}`}
                  onClick={e => { e.stopPropagation(); onConnect(i, loc, arrISO); }}
                  title="Show connecting trains">🔗</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Service header ───────────────────────────────────────────────────────────

function ServiceHeader({ data, onBack, onFav }) {
  if (!data?.service) return null;
  const { scheduleMetadata, origin, destination } = data.service;
  const uid = scheduleMetadata?.identity;
  const name = `${origin?.[0]?.location?.description} → ${destination?.[0]?.location?.description}`;
  return (
    <div className="service-header">
      <button className="btn-back" onClick={onBack}>← Back</button>
      <span className="headcode">{scheduleMetadata?.trainReportingIdentity}</span>
      <span className="route">{name}</span>
      <span className="operator">{scheduleMetadata?.operator?.name}</span>
      <span className="uid">UID: {uid}</span>
      {uid && <FavouriteStar uid={uid} name={name} />}
    </div>
  );
}

function RefreshCountdown({ seconds, onRefresh, routeStatus }) {
  return (
    <div className="refresh-bar">
      <span>Auto-refresh in {seconds}s</span>
      {routeStatus === 'loading' && <span className="route-status loading">⟳ Routing track…</span>}
      {routeStatus === 'routed' && <span className="route-status routed">✓ Track routed</span>}
      {routeStatus === 'straight' && <span className="route-status straight">~ Straight line</span>}
      <button className="btn-sm" onClick={onRefresh}>↻ Now</button>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('App error:', e, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:'24px',color:'#fca5a5',background:'#0f1117',height:'100vh'}}>
          <h2>Something went wrong</h2>
          <p style={{color:'#64748b',fontSize:'0.85rem'}}>{this.state.error?.message}</p>
          <button onClick={() => this.setState({error:null})}
            style={{marginTop:'12px',padding:'8px 16px',background:'#3b82f6',color:'#fff',border:'none',borderRadius:'6px',cursor:'pointer'}}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [mode, setMode] = useState('board');
  const [serviceData, setServiceData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [currentSearch, setCurrentSearch] = useState(null);
  const [activeStop, setActiveStop] = useState(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [uidInput, setUidInput] = useState('');
  const [dateInput, setDateInput] = useState(new Date().toISOString().slice(0,10));
  const [tileKey, setTileKey] = useState(() => lsGet('tt_tile', 'dark'));
  const [boardState, setBoardState] = useState(null); // persisted board state
  const [trackRoute, setTrackRoute] = useState(null); // routed track geometry
  const [routeLoading, setRouteLoading] = useState(false);
  const [connStop, setConnStop] = useState(null); // { idx, loc, arrISO }
  const [mobileTab, setMobileTab] = useState('map'); // 'map' | 'list'
  const [connDestCode, setConnDestCode] = useState(null);
  const [connDestName, setConnDestName] = useState(null);
  const timerRef = useRef(null);
  const mapRef = useRef(null);

  const fetchService = useCallback(async ({ uid, date }) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/service/${uid}?run_date=${date}`);
      if (!res.ok) throw new Error(((await res.json().catch(()=>({}))).detail) || `HTTP ${res.status}`);
      const svcData = await res.json();
      setServiceData(svcData);
      setCountdown(REFRESH_INTERVAL / 1000);
      setMode('map');
      // Fetch track route geometry asynchronously (non-blocking, 45s timeout)
      setTrackRoute(null);
      setRouteLoading(true);
      const routeController = new AbortController();
      const routeTimeout = setTimeout(() => routeController.abort(), 45000);
      fetch(`${API_BASE}/api/route/${uid}?run_date=${date}`, { signal: routeController.signal })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.route) setTrackRoute(d.route); })
        .catch(() => {})
        .finally(() => { clearTimeout(routeTimeout); setRouteLoading(false); });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const loadService = useCallback((uid, date) => {
    const d = date || new Date().toISOString().slice(0,10);
    setCurrentSearch({ uid, date: d });
    setActiveStop(null);
    setMobileTab('map');
    fetchService({ uid, date: d });
  }, [fetchService]);

  useEffect(() => {
    if (!currentSearch || mode !== 'map') return;
    clearInterval(timerRef.current);
    let secs = REFRESH_INTERVAL / 1000;
    timerRef.current = setInterval(() => {
      secs -= 1; setCountdown(secs);
      if (secs <= 0) { secs = REFRESH_INTERVAL / 1000; fetchService(currentSearch); }
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [currentSearch, mode, fetchService]);

  const handleBack = () => {
    setMode('board'); setServiceData(null); setError(null); setTrackRoute(null); setConnStop(null);
    clearInterval(timerRef.current);
  };

  const handleConnect = (idx, loc, arrISO) => {
    if (connStop?.idx === idx) { setConnStop(null); return; } // toggle off
    setConnStop({ idx, loc, arrISO });
  };

  const switchTile = (key) => { setTileKey(key); lsSet('tt_tile', key); };

  const locations = serviceData?.service?.locations || [];
  // All locations with coords (for position estimation, including junctions)
  const allMappedLocs = locations.filter(l => l.lat && l.lon);
  // Only public calls shown as map markers
  const mappedStops = locations.filter(l => l.lat && l.lon && !isPass(l));
  const positions = mappedStops.map(l => [l.lat, l.lon]);
  const trainPos = serviceData ? safePosition(estimatePosition(locations)) : null;
  const missingCoords = locations.filter(l => !isPass(l) && !l.lat).length;
  const activeStatusColour = (() => {
    const a = locations.find(l => locationStatus(l)?.pulse);
    return a ? locationStatus(a).colour : '#60a5fa';
  })();

  const handleSelectStop = (idx) => {
    setActiveStop(idx);
    const loc = locations[idx];
    if (loc?.lat && mapRef.current) mapRef.current.panTo([loc.lat, loc.lon], { animate: true });
  };

  const tabs = [
    { id: 'board', label: '🚉 Departures' },
    { id: 'favs', label: '★ Favourites' },
    { id: 'headcode', label: '🔢 Headcode' },
    { id: 'uid', label: '🔑 UID' },
  ];

  return (
    <ErrorBoundary>
    <div className="app">
      <header className="header">
        <div className="logo">🚆 Train Tracker</div>
        {mode !== 'map' ? (
          <div className="header-tabs">
            {tabs.map(t => (
              <button key={t.id} className={`tab ${mode === t.id ? 'active' : ''}`} onClick={() => setMode(t.id)}>{t.label}</button>
            ))}
          </div>
        ) : (
          // Tile switcher in map mode
          <div className="tile-switcher">
            {Object.entries(MAP_TILES).map(([k, v]) => (
              <button key={k} className={`tile-btn ${tileKey === k ? 'active' : ''}`} onClick={() => switchTile(k)}>{v.label}</button>
            ))}
          </div>
        )}
        {mode === 'uid' && (
          <form className="search-bar" onSubmit={e => { e.preventDefault(); if (uidInput.trim()) loadService(uidInput.trim().toUpperCase(), dateInput); }}>
            <div className="search-group"><label>Service UID</label>
              <input value={uidInput} onChange={e => setUidInput(e.target.value)} placeholder="e.g. C16998" className="input" spellCheck={false} />
            </div>
            <div className="search-group"><label>Date</label>
              <input type="date" value={dateInput} onChange={e => setDateInput(e.target.value)} className="input" />
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Loading…' : 'Track'}</button>
          </form>
        )}
      </header>

      {error && <div className="error-banner">⚠ {error}</div>}

      {mode === 'map' && serviceData && (
        <>
          <ServiceHeader data={serviceData} onBack={handleBack} />
          <RollingStock service={serviceData.service} />
          <DelayReasons service={serviceData.service} />
          <JourneyProgress locations={locations} />
          {missingCoords > 0 && <div className="warn-banner">⚠ {missingCoords} stop{missingCoords > 1 ? 's' : ''} missing coordinates</div>}
          <RefreshCountdown seconds={countdown} onRefresh={() => fetchService(currentSearch)}
            routeStatus={routeLoading ? 'loading' : trackRoute ? 'routed' : 'straight'} />
        </>
      )}

      <div className="main">
        {/* Mobile tab bar — only shown in map mode */}
        {mode === 'map' && serviceData && (
          <div className="mobile-tabs">
            <button className={`mobile-tab ${mobileTab === 'map' ? 'active' : ''}`} onClick={() => setMobileTab('map')}>🗺 Map</button>
            <button className={`mobile-tab ${mobileTab === 'list' ? 'active' : ''}`} onClick={() => setMobileTab('list')}>📋 Stops</button>
          </div>
        )}

        <div className={`sidebar ${mode === 'map' && mobileTab === 'map' ? 'mobile-hidden' : ''}`}>
          {mode === 'board' && <DepartureBoard onSelectService={loadService} savedState={boardState} onSaveState={setBoardState} />}
          {mode === 'favs' && <FavouritesList onLoad={loadService} />}
          {mode === 'headcode' && <HeadcodeSearch onSelectService={loadService} />}
          {mode === 'uid' && !serviceData && !loading && (
            <div className="empty-state"><div className="empty-icon">🚆</div><p>Enter a service UID to track a train</p><p className="hint">Find UIDs on realtimetrains.co.uk</p></div>
          )}
          {loading && mode !== 'map' && <div className="loading-state">Loading…</div>}
          {mode === 'map' && serviceData && (
            <>
              <StopList locations={locations} activeStop={activeStop} onSelect={handleSelectStop}
                onConnect={handleConnect} activeConn={connStop?.idx} />
              {connStop && (
                <ConnectionsPanel
                  stop={connStop.loc}
                  arrivalISO={connStop.arrISO}
                  destCode={connDestCode || boardState?.destCode}
                  destName={connDestName || boardState?.dest}
                  onSelectService={loadService}
                  onClose={() => setConnStop(null)}
                  leg={1}
                />
              )}
            </>
          )}
        </div>

        <div className={`map-wrap ${mode === 'map' && mobileTab === 'list' ? 'mobile-hidden' : ''}`}>
          <MapContainer center={[52.5, -1.5]} zoom={7} style={{ height: '100%', width: '100%' }} ref={mapRef}>
            <TileLayerSwitcher tileKey={tileKey} />
            {positions.length > 1 && (
              <>
                <MapFitter positions={positions} fitKey={currentSearch?.uid} />
                {/* Actual track geometry if available, otherwise straight lines */}
                {trackRoute && trackRoute.length > 1
                  ? <Polyline positions={trackRoute} pathOptions={{ color: '#3b82f6', weight: 3, opacity: 0.9 }} />
                  : <Polyline positions={positions} pathOptions={{ color: '#3b82f6', weight: 3, opacity: 0.5, dashArray: routeLoading ? '6 6' : undefined }} />
                }
              </>
            )}
            {mappedStops.filter(l => !isNaN(l.lat) && !isNaN(l.lon)).map((loc, i) => {
              const colour = stopColour(loc);
              const isActive = activeStop === locations.indexOf(loc);
              const st = locationStatus(loc);
              const td = loc.temporalData;
              const dep = td?.departure; const arr = td?.arrival;
              const delay = delayMins(td, dep ? 'departure' : 'arrival');
              const platform = loc.locationMetadata?.platform?.actual || loc.locationMetadata?.platform?.planned;
              return (
                <CircleMarker key={i} center={[loc.lat, loc.lon]}
                  radius={st?.pulse ? 9 : isActive ? 10 : 6}
                  pathOptions={{ fillColor: colour, color: st?.pulse ? colour : isActive ? '#fff' : colour, weight: st?.pulse ? 2 : isActive ? 2 : 1, fillOpacity: 1, className: st?.pulse ? 'map-pulse' : '' }}
                  eventHandlers={{ click: () => handleSelectStop(locations.indexOf(loc)) }}>
                  <Popup>
                    <div className="popup">
                      <strong>{loc.location?.description}</strong>
                      {loc.location?.shortCodes?.[0] && <span> ({loc.location.shortCodes[0]})</span>}
                      {st && <><br /><span style={{ color: st.colour }}>● {st.label}</span></>}
                      <br /><span>Sch: {fmtISO(dep?.scheduleAdvertised || arr?.scheduleAdvertised)}</span>
                      {(dep?.realtimeActual || dep?.realtimeEstimate) && (
                        <><br /><span>RT: {fmtISO(dep.realtimeActual || dep.realtimeEstimate)}</span>
                        {delay !== null && delay !== 0 && <span className={delay > 0 ? 'late' : 'early'}> ({delay > 0 ? '+' : ''}{delay}m)</span>}</>
                      )}
                      {platform && <><br /><span>Platform: {platform}</span></>}
                      {(dep?.isCancelled || arr?.isCancelled) && <><br /><span style={{color:'#ef4444'}}>CANCELLED</span></>}
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
            {trainPos && !isNaN(trainPos.lat) && !isNaN(trainPos.lon) && (
              <Marker position={[trainPos.lat, trainPos.lon]} icon={trainIcon(activeStatusColour)}>
                <Popup>{trainPos.label}</Popup>
              </Marker>
            )}
          </MapContainer>
          {mode === 'map' && serviceData && (
            <div className="legend">
              <span><span className="dot" style={{background:'#22c55e'}}/>Departed</span>
              <span><span className="dot" style={{background:'#f59e0b'}}/>Due/Late</span>
              <span><span className="dot" style={{background:'#94a3b8'}}/>Upcoming</span>
              <span><span className="dot" style={{background:'#ef4444'}}/>Cancelled</span>
              {locations.some(l => locationStatus(l)?.pulse) && <>
                <span><span className="dot" style={{background:'#fbbf24'}}/>Arriving</span>
                <span><span className="dot" style={{background:'#a78bfa'}}/>At platform</span>
              </>}
            </div>
          )}
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}
