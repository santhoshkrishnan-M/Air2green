/* AIR2GREEN web app. Everything on screen comes from live public data:
   - Open-Meteo air-quality API (CAMS): PM2.5, PM10, dust, carbon monoxide
   - Open-Meteo weather API: wind speed, boundary-layer (mixing) height
   - OpenStreetMap via Overpass: schools, hospitals, major roads, parks
   No API keys. Data refreshes automatically every 15 minutes. */
(function () {
"use strict";

/* ------------------------------------------------------------------ config */
const CFG = {
  AQ: "https://air-quality-api.open-meteo.com/v1/air-quality",
  WX: "https://api.open-meteo.com/v1/forecast",
  OVERPASS: ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
             "https://overpass.private.coffee/api/interpreter"],
  API: window.A2G_API || "",            // optional AWS backend (template.yaml ApiUrl); not required
  REFRESH_MS: 15 * 60 * 1000,
  WORLD_TTL: 30 * 60 * 1000, CITY_TTL: 10 * 60 * 1000, SITES_TTL: 7 * 24 * 3600 * 1000,
  BATCH: 80,
  SITE_RADIUS_M: 2000,
  WHO_24H: 15,
  IO_RATIO: 0.6,                         // indoor/outdoor PM2.5 with windows closed (studies: ~0.4-0.9)
  BLOCK_M2: 62500,                       // 250 m x 250 m block around a site
  TREE_G_YR: 12.5,                       // PM2.5 removed per reference tree per year (placeholder; cite locally)
  PLANTABLE: 0.05, TREE_CANOPY_M2: 50,
};

/* Air quality scales (PM2.5, µg/m³). `lvl` = how strong the response is:
   0 fine · 1 sensitive groups take care · 2 alert: move children's outdoor activity indoors
   3 severe: cancel outdoor activity · 4 emergency */
const SCALES = {
  epa: { name: "US EPA AQI (2024)", short: "US EPA",
    bands: [
      { max: 9.0,   name: "Good",                         col: "#3fae5a", fg: "#0b1f12", lvl: 0 },
      { max: 35.4,  name: "Moderate",                     col: "#e9d23a", fg: "#2a2405", lvl: 1 },
      { max: 55.4,  name: "Unhealthy for sensitive groups", short: "Sensitive groups", col: "#f08a24", fg: "#2b1503", lvl: 2 },
      { max: 125.4, name: "Unhealthy",                    col: "#df3f2e", fg: "#ffffff", lvl: 3 },
      { max: 225.4, name: "Very unhealthy", short: "Very unhealthy", col: "#8f3f97", fg: "#ffffff", lvl: 4 },
      { max: 1e9,   name: "Hazardous",                    col: "#7e0023", fg: "#ffffff", lvl: 4 },
    ] },
  cpcb: { name: "India CPCB National AQI", short: "CPCB",
    bands: [
      { max: 30,  name: "Good",         col: "#2f9e5b", fg: "#ffffff", lvl: 0 },
      { max: 60,  name: "Satisfactory", col: "#a3c853", fg: "#14210a", lvl: 0 },
      { max: 90,  name: "Moderate",     col: "#e9d23a", fg: "#2a2405", lvl: 1 },
      { max: 120, name: "Poor",         col: "#f08a24", fg: "#2b1503", lvl: 2 },
      { max: 250, name: "Very poor",    col: "#df3f2e", fg: "#ffffff", lvl: 3 },
      { max: 1e9, name: "Severe",       col: "#8a1c1c", fg: "#ffffff", lvl: 4 },
    ] },
};
const LEVEL_TEXT = [
  "Air is fine for everyone.",
  "Fine for most people. Children and people with asthma or heart disease should watch for symptoms.",
  "Children, older adults and people with lung or heart conditions should cut long or heavy outdoor activity.",
  "Everyone should cut outdoor exertion. Sensitive groups should stay indoors.",
  "Health alert. Everyone should stay indoors as much as possible.",
];
const SITE = {
  school:   { label: "School",   people: 600, hours: [8, 16], shift: 1.5, who: "students" },
  kindergarten: { label: "Kindergarten", people: 100, hours: [8, 14], shift: 1.5, who: "children" },
  college:  { label: "College",  people: 900, hours: [9, 17], shift: 1.0, who: "students" },
  university: { label: "University", people: 900, hours: [9, 17], shift: 1.0, who: "students" },
  hospital: { label: "Hospital", people: 300, hours: [0, 24], shift: 0.5, who: "patients and visitors" },
  clinic:   { label: "Clinic",   people: 60,  hours: [8, 20], shift: 0.5, who: "patients" },
};
const SITE_GROUP = { school: "edu", kindergarten: "edu", college: "edu", university: "edu", hospital: "health", clinic: "health" };
const INDIA_SPECIES = ["Neem (Azadirachta indica)", "Pongam (Millettia pinnata)", "Mast tree (Polyalthia longifolia)",
  "Arjun (Terminalia arjuna)", "Jamun (Syzygium cumini)", "Ixora (hedge)", "Bougainvillea (hedge, walls)"];

/* ------------------------------------------------------------------ data */
const PLACES = window.A2G_PLACES || [];
const BY_CC = Object.fromEntries(PLACES.map(p => [p.c, p]));
const TOPO = window.A2G_TOPO;
const FEATURES = topojson.feature(TOPO, TOPO.objects.countries).features;

/* ------------------------------------------------------------------ helpers */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 0) => n == null || isNaN(n) ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const r1 = n => Math.round(n * 10) / 10;
const mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const maxOf = a => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) : null; };
const store = {
  get(k, ttl) { try { const o = JSON.parse(localStorage.getItem("a2g:" + k)); if (o && (!ttl || Date.now() - o.t < ttl)) return o.v; } catch (_) {} return null; },
  set(k, v) { try { localStorage.setItem("a2g:" + k, JSON.stringify({ t: Date.now(), v })); } catch (_) {} },
};
function scaleFor(cc) {
  const s = state.scale;
  if (s === "epa" || s === "cpcb") return SCALES[s];
  return cc === "IN" ? SCALES.cpcb : SCALES.epa;
}
function worldScale() { return state.scale === "cpcb" ? SCALES.cpcb : SCALES.epa; }
function band(v, scale) {
  if (v == null || isNaN(v)) return null;
  return scale.bands.find(b => v <= b.max) || scale.bands[scale.bands.length - 1];
}
const alertLevel = scale => { const i = scale.bands.findIndex(b => b.lvl >= 2); return scale.bands[i - 1].max; }; // value above which we alert
function chip(v, scale) {
  const b = band(v, scale);
  return b ? `<span class="chip" style="background:${b.col};color:${b.fg}" title="${esc(b.name)}">${esc(b.short || b.name)}</span>` : `<span class="chip soft">No data</span>`;
}
function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parseLocal(s) { // "2026-10-10T09:00" (local time of the place) -> parts, no timezone conversion
  const [d, t] = s.split("T"); const [y, mo, da] = d.split("-").map(Number); const [h, mi] = t.split(":").map(Number);
  return { y, mo, da, h, mi, dow: new Date(Date.UTC(y, mo - 1, da)).getUTCDay() };
}
const hhmm = h => String(h).padStart(2, "0") + ":00";
function whenLabel(s, nowS) {
  const p = parseLocal(s), n = parseLocal(nowS);
  const dayDiff = Math.round((Date.UTC(p.y, p.mo - 1, p.da) - Date.UTC(n.y, n.mo - 1, n.da)) / 864e5);
  const day = dayDiff === 0 ? "today" : dayDiff === 1 ? "tomorrow" : dayDiff === -1 ? "yesterday" : DOW[p.dow];
  return `${day} ${hhmm(p.h)}`;
}

/* ------------------------------------------------------------------ fetch */
async function getJSON(url, opts = {}, timeout = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); if (j.reason) msg += `: ${j.reason}`; } catch (_) {}
      throw new Error(msg);
    }
    return await r.json();
  } finally { clearTimeout(t); }
}
async function airMulti(locs, extra) {
  // Open-Meteo accepts many coordinates per request; one location -> object, several -> array
  const out = [];
  for (let i = 0; i < locs.length; i += CFG.BATCH) {
    const part = locs.slice(i, i + CFG.BATCH);
    const q = new URLSearchParams({ latitude: part.map(l => l[0]).join(","), longitude: part.map(l => l[1]).join(","), timezone: "auto", ...extra });
    const j = await getJSON(`${CFG.AQ}?${q}`);
    out.push(...(Array.isArray(j) ? j : [j]));
  }
  return out;
}
function summarise(r) { // current value + next-24h peak from an hourly pm2_5 series
  const cur = r?.current?.pm2_5 ?? null;
  const hp = r?.hourly?.pm2_5 || [];
  return { pm: cur, peak24: maxOf(hp.slice(0, 24)), time: r?.current?.time, tz: r?.timezone, off: r?.utc_offset_seconds };
}
async function loadWorld(force) {
  const cached = !force && store.get("world", CFG.WORLD_TTL);
  if (cached) return cached;
  const locs = PLACES.map(p => [p.cap[1], p.cap[2]]);
  const res = await airMulti(locs, { current: "pm2_5,pm10", hourly: "pm2_5", forecast_hours: "24" });
  const data = { t: Date.now(), byCC: {} };
  PLACES.forEach((p, i) => { data.byCC[p.c] = summarise(res[i]); });
  store.set("world", data);
  return data;
}
async function loadCountry(cc, force) {
  const key = "country:" + cc;
  const cached = !force && store.get(key, CFG.WORLD_TTL);
  if (cached) return cached;
  const p = BY_CC[cc];
  const res = await airMulti(p.cities.map(c => [c[1], c[2]]), { current: "pm2_5,pm10", hourly: "pm2_5", forecast_hours: "24" });
  const data = { t: Date.now(), cities: res.map(summarise) };
  store.set(key, data);
  return data;
}
async function loadCity(lat, lon, force) {
  const key = `city:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = !force && store.get(key, CFG.CITY_TTL);
  if (cached) return cached;
  const common = { latitude: lat, longitude: lon, timezone: "auto", past_days: "1", forecast_days: "4" };
  const [aq, wx] = await Promise.all([
    getJSON(`${CFG.AQ}?${new URLSearchParams({ ...common, current: "pm2_5,pm10,dust,carbon_monoxide",
      hourly: "pm2_5,pm10,dust,carbon_monoxide" })}`),
    getJSON(`${CFG.WX}?${new URLSearchParams({ ...common, hourly: "wind_speed_10m,wind_direction_10m,boundary_layer_height",
      wind_speed_unit: "ms" })}`).catch(e => ({ error: String(e) })),
  ]);
  const data = { t: Date.now(), aq, wx };
  store.set(key, data);
  return data;
}
async function loadSites(lat, lon) {
  const key = `sites:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = store.get(key, CFG.SITES_TTL);
  if (cached) return cached;
  const R = CFG.SITE_RADIUS_M;
  const q = `[out:json][timeout:30];
nwr["amenity"~"^(school|kindergarten|college|university|hospital|clinic)$"](around:${R},${lat},${lon});
out center tags 400;
way["highway"~"^(motorway|trunk|primary)$"](around:${R},${lat},${lon});
out geom 400;
(way["leisure"="park"](around:${R},${lat},${lon});way["landuse"~"^(forest|grass|recreation_ground|village_green)$"](around:${R},${lat},${lon});way["natural"="wood"](around:${R},${lat},${lon}););
out center 600;`;
  let lastErr;
  for (const url of CFG.OVERPASS) {
    try {
      const j = await getJSON(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }, 40000);
      const data = parseSites(j.elements || [], lat, lon);
      store.set(key, data);
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Overpass unavailable");
}

/* ------------------------------------------------------------------ geometry + sites */
const M_PER_DEG = 111320;
function xy(lat, lon, lat0, lon0) { return [(lon - lon0) * M_PER_DEG * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * M_PER_DEG]; }
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function parseSites(els, lat0, lon0) {
  const sites = [], roads = [], green = [];
  for (const e of els) {
    const tg = e.tags || {};
    if (e.type === "way" && tg.highway && e.geometry) {
      roads.push({ name: tg.name || tg.ref || tg.highway, type: tg.highway, pts: e.geometry.map(g => xy(g.lat, g.lon, lat0, lon0)) });
    } else if (tg.amenity && SITE[tg.amenity]) {
      const c = e.center || { lat: e.lat, lon: e.lon };
      if (c.lat == null) continue;
      let people = SITE[tg.amenity].people, src = "estimate";
      const cap = parseInt(tg.capacity || tg["capacity:pupils"] || "", 10), beds = parseInt(tg.beds || "", 10);
      if (cap > 0 && cap < 20000) { people = cap; src = "OpenStreetMap capacity"; }
      else if (tg.amenity === "hospital" && beds > 0 && beds < 5000) { people = beds * 2; src = "beds × 2"; }
      sites.push({ id: e.type[0] + e.id, type: tg.amenity, name: tg.name || tg["name:en"] || `Unnamed ${SITE[tg.amenity].label.toLowerCase()}`,
        named: !!(tg.name || tg["name:en"]), lat: c.lat, lon: c.lon, xy: xy(c.lat, c.lon, lat0, lon0), people, src });
    } else if (e.center && (tg.leisure || tg.landuse || tg.natural)) {
      green.push(xy(e.center.lat, e.center.lon, lat0, lon0));
    }
  }
  for (const s of sites) {
    let best = { d: Infinity, name: null };
    for (const r of roads) for (let i = 1; i < r.pts.length; i++) {
      const d = segDist(s.xy, r.pts[i - 1], r.pts[i]); if (d < best.d) best = { d, name: r.name, type: r.type };
    }
    s.roadDist = best.d; s.road = best.name; s.roadType = best.type;
    s.greenNear = green.filter(g => Math.hypot(g[0] - s.xy[0], g[1] - s.xy[1]) <= 300).length;
  }
  return { sites, roads: roads.map(r => ({ name: r.name, pts: r.pts.filter((_, i) => i % 2 === 0 || i === r.pts.length - 1) })), green, t: Date.now() };
}

/* ------------------------------------------------------------------ analysis (mirrors air2green/response.py) */
function analyseCity(raw, cc) {
  const aq = raw.aq, wx = raw.wx || {};
  const T = aq.hourly.time, pm = aq.hourly.pm2_5;
  const nowStr = (aq.current?.time || T[0]).slice(0, 13) + ":00";
  let now = T.indexOf(nowStr); if (now < 0) now = Math.min(T.length - 1, 24);
  const scale = scaleFor(cc), thr = alertLevel(scale);
  const wxT = wx.hourly?.time || [], wxIdx = Object.fromEntries(wxT.map((t, i) => [t, i]));
  const wind = T.map(t => wx.hourly?.wind_speed_10m?.[wxIdx[t]] ?? null);
  const blh = T.map(t => wx.hourly?.boundary_layer_height?.[wxIdx[t]] ?? null);
  // events: contiguous hours above the alert level; close after 2 clean hours
  const events = []; let cur = null, quiet = 0;
  for (let i = 0; i < T.length; i++) {
    const v = pm[i];
    if (v != null && v > thr) { if (!cur) cur = { s: i, e: i, peak: v, pi: i }; cur.e = i; if (v > cur.peak) { cur.peak = v; cur.pi = i; } quiet = 0; }
    else if (cur) { quiet++; if (quiet >= 2) { events.push(cur); cur = null; quiet = 0; } }
  }
  if (cur) { cur.open = true; events.push(cur); }
  const active = events.find(e => e.s <= now && now <= e.e + 1);
  const next = events.find(e => e.s > now && e.s <= now + 48);
  const focus = active || next || null;
  // best 2-hour daytime window in the next 36 h
  let best = null;
  for (let i = now; i < Math.min(T.length - 1, now + 36); i++) {
    const h = parseLocal(T[i]).h; if (h < 6 || h > 18) continue;
    const v = (pm[i] + pm[i + 1]) / 2; if (pm[i] == null || pm[i + 1] == null) continue;
    if (!best || v < best.v) best = { i, v };
  }
  // daily summary (today + 3 days)
  const days = [];
  for (let i = 0; i < T.length; i++) {
    const p = parseLocal(T[i]); const k = `${p.y}-${p.mo}-${p.da}`;
    if (i < now - parseLocal(T[now]).h) continue;
    let d = days.find(x => x.k === k); if (!d) { d = { k, t: T[i], vals: [] }; days.push(d); }
    d.vals.push(pm[i]);
  }
  days.forEach(d => { d.max = maxOf(d.vals); d.avg = mean(d.vals); });
  const fi = focus ? focus.pi : now;
  const cause = likelyCause({ pm: pm[fi], pm10: aq.hourly.pm10?.[fi], dust: aq.hourly.dust?.[fi], co: aq.hourly.carbon_monoxide?.[fi],
    wind: wind[fi], blh: blh[fi], h: parseLocal(T[fi]).h, rise: pm[fi] - (pm[Math.max(0, fi - 3)] ?? pm[fi]) });
  const past24 = pm.slice(Math.max(0, now - 23), now + 1);
  const blh24 = mean(blh.slice(Math.max(0, now - 23), now + 1));
  return { T, pm, now, nowStr, scale, thr, events, active, next, focus, best, days: days.slice(0, 4), cause, wind, blh,
    cur: aq.current?.pm2_5 ?? pm[now], mean24: mean(past24), blh24, tz: aq.timezone, off: aq.utc_offset_seconds,
    wxOk: !!wx.hourly };
}
function likelyCause(s) {
  const sig = s;
  const out = { signals: sig };
  if (s.dust != null && s.pm10 && s.dust >= 0.5 * s.pm10 && s.pm10 > 50) {
    return { ...out, key: "dust", cause: "Desert or wind-blown dust",
      why: `Dust makes up about ${Math.round(s.dust / s.pm10 * 100)}% of coarse particles (PM10) in the model.`,
      source: "Little can be controlled locally: warn the public early, damp down construction and road dust, keep windows closed." };
  }
  if ((s.wind != null && s.wind < 2) || (s.blh != null && s.blh < 300)) {
    return { ...out, key: "stagnant", cause: "Still air trapping local pollution",
      why: `Weak wind${s.wind != null ? ` (${r1(s.wind)} m/s)` : ""} and a shallow mixing layer${s.blh != null ? ` (${Math.round(s.blh)} m)` : ""} keep traffic, cooking and burning smoke near the ground.`,
      source: "Pause open burning and dusty construction until the air mixes again; ease traffic near schools and hospitals." };
  }
  const rush = [7, 8, 9, 10, 17, 18, 19, 20, 21].includes(s.h);
  if (s.co != null && s.co > 500 && rush) {
    return { ...out, key: "traffic", cause: "Traffic and fuel burning at rush hour",
      why: `Carbon monoxide is raised (${Math.round(s.co)} µg/m³) at a peak traffic hour, a sign of combustion close by.`,
      source: "Ask traffic police to keep traffic moving near schools; stop buses and trucks idling; check for waste burning." };
  }
  if (s.co != null && s.co > 500) {
    return { ...out, key: "smoke", cause: "Smoke from burning (fires, waste or crop burning)",
      why: `Carbon monoxide is raised (${Math.round(s.co)} µg/m³) outside rush hour, which points to burning rather than traffic.`,
      source: "Ask the municipality to check for and stop waste, crop or biomass burning in and around the city." };
  }
  return { ...out, key: "regional", cause: "Regional haze carried in from elsewhere",
    why: "No strong local signal (dust, still air or combustion) at this hour, so the particles are likely carried in from farther away.",
    source: "Local action has limited effect today; focus on protecting people and report the episode to the regional pollution board." };
}
function exposureFor(site, A, ev) {
  const prof = SITE[site.type]; if (!prof || !ev) return { ph: 0, cut: 0, present: 0 };
  const hours = []; for (let i = ev.s; i <= ev.e; i++) { const h = parseLocal(A.T[i]).h; if (h >= prof.hours[0] && h < prof.hours[1]) hours.push(i); }
  if (!hours.length) return { ph: 0, cut: 0, present: 0, closed: true };
  const shifted = Math.min(prof.shift, hours.length);
  const avg = mean(hours.map(i => A.pm[i]));
  const before = hours.length * avg, after = before - shifted * avg * (1 - CFG.IO_RATIO);
  return { ph: Math.round(site.people * shifted), cut: before ? (before - after) / before * 100 : 0, present: hours.length, avg };
}
function greenGap(site, A) {
  const excess = Math.max(0, (A.mean24 ?? 0) - CFG.WHO_24H);
  const pol = Math.min(1, excess / 85);
  const road = site.roadDist <= 60 ? 1 : site.roadDist <= 200 ? 0.6 : 0.3;
  const greenLack = 1 - Math.min(1, site.greenNear / 3);
  const ppl = 0.3 + 0.7 * Math.min(1, site.people / 1000);
  const blh = Math.max(100, Math.min(3000, A.blh24 || 1000));
  const massG = excess * CFG.BLOCK_M2 * blh * 1e-6;
  const trees = Math.round(massG / CFG.TREE_G_YR);
  const fit = Math.floor(CFG.BLOCK_M2 * CFG.PLANTABLE / CFG.TREE_CANOPY_M2);
  return { score: pol * road * greenLack * ppl, excess, blh, blhLive: !!A.blh24, massG, trees, fit, road, greenLack };
}

/* ------------------------------------------------------------------ state + routing */
const state = { scale: store.get("scale") || "auto", view: "world", cc: null, ci: null, here: null,
  world: null, country: null, city: null, cityA: null, sites: null, sitesErr: null, siteFilter: "all",
  done: store.get("done") || {}, refreshTimer: null, lastOk: null, worldTab: "worst", showAllSites: false, error: null };
$("scale").value = state.scale;

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  state.showAllSites = false;
  if (h === "here" && state.here) { state.view = "city"; state.cc = state.here.cc; state.ci = null; }
  else if (/^[A-Z]{2}-\d+$/.test(h) && BY_CC[h.slice(0, 2)]) { state.view = "city"; state.cc = h.slice(0, 2); state.ci = +h.slice(3); }
  else if (/^[A-Z]{2}$/.test(h) && BY_CC[h]) { state.view = "country"; state.cc = h; state.ci = null; }
  else { state.view = "world"; state.cc = null; state.ci = null; }
  const key = state.view === "city" ? (() => { const c = cityRef(); return `${c.lat},${c.lon}`; })() : state.view === "country" ? state.cc : "world";
  if (key !== state.key) { state.key = key; state.city = null; state.cityA = null; if (state.view === "country") state.country = null; }
  render(); refresh(false);
}
function cityRef() {
  if (state.ci == null && state.here) return { name: state.here.name, lat: state.here.lat, lon: state.here.lon, cc: state.here.cc, pop: null };
  const p = BY_CC[state.cc]; const c = p.cities[state.ci] || p.cities[0];
  return { name: c[0], lat: c[1], lon: c[2], cc: p.c, pop: c[3] };
}

/* ------------------------------------------------------------------ refresh loop */
let inflight = 0;
async function refresh(force) {
  const my = ++inflight;
  setLive("loading");
  try {
    if (state.view === "world") { state.world = await loadWorld(force); }
    else if (state.view === "country") { state.country = await loadCountry(state.cc, force); if (!state.world) loadWorld(false).then(w => { state.world = w; }).catch(() => {}); }
    else {
      const c = cityRef();
      state.city = await loadCity(c.lat, c.lon, force);
      state.cityA = analyseCity(state.city, c.cc);
      if (!state.sites || state.sites.key !== `${c.lat},${c.lon}`) {
        state.sites = null; state.sitesErr = null;
        loadSites(c.lat, c.lon).then(s => { if (my !== inflight && cityRef().lat !== c.lat) return; state.sites = { ...s, key: `${c.lat},${c.lon}` }; render(); })
          .catch(e => { state.sitesErr = String(e.message || e); render(); });
      }
    }
    if (my !== inflight) return;
    state.error = null; state.lastOk = dataTime(); setLive("on"); render();
  } catch (e) {
    if (my !== inflight) return;
    state.error = String(e.message || e); setLive("err"); render();
  }
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refresh(true), state.error ? 60000 : CFG.REFRESH_MS);
}
function dataTime() { return state.view === "world" ? state.world?.t : state.view === "country" ? state.country?.t : state.city?.t; }
function setLive(mode) {
  const el = $("live"); el.className = "live " + (mode === "on" ? "on" : mode === "err" ? "err" : "");
  const t = dataTime();
  el.innerHTML = mode === "loading" ? `<i></i><span>Updating…</span>`
    : mode === "err" ? `<i></i><span>Offline</span> <button type="button" data-act="refresh">Retry</button>`
    : `<i></i><span>Live · updated ${t ? timeAgo(t) : "now"}</span> <button type="button" data-act="refresh" title="Refresh now">↻</button>`;
}
setInterval(() => { if ($("live").classList.contains("on")) setLive("on"); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && dataTime() && Date.now() - dataTime() > CFG.REFRESH_MS) refresh(true); });

/* ------------------------------------------------------------------ render */
function render() {
  renderCrumbs();
  const b = $("banner");
  if (state.error) {
    b.hidden = false;
    b.innerHTML = `<span><b>Live data could not load.</b> ${esc(state.error)}. Check your internet connection; the app retries every minute.</span><button class="btn" type="button" data-act="refresh">Try again</button>`;
  } else b.hidden = true;
  if (state.view === "world") renderWorld();
  else if (state.view === "country") renderCountry();
  else renderCity();
}
function renderCrumbs() {
  const parts = [`<a href="#world">World</a>`];
  if (state.cc) parts.push(state.view === "country" ? `<b>${esc(BY_CC[state.cc].n)}</b>` : `<a href="#${state.cc}">${esc(BY_CC[state.cc].n)}</a>`);
  if (state.view === "city") parts.push(`<b>${esc(cityRef().name)}</b>`);
  $("crumbs").innerHTML = parts.join(`<span aria-hidden="true">›</span>`);
}

/* ---------- world */
function renderWorld() {
  const v = $("view"), W = state.world, sc = worldScale();
  if (!W) { v.innerHTML = `<div class="panel"><p class="skeleton">Loading live air quality for ${PLACES.length} countries and territories…</p></div>`; return; }
  const rows = PLACES.map(p => ({ p, ...W.byCC[p.c] })).filter(r => r.pm != null);
  const counts = sc.bands.map(b => ({ b, n: 0 }));
  rows.forEach(r => { const i = sc.bands.indexOf(band(r.pm, sc)); counts[i].n++; });
  const overWHO = rows.filter(r => r.pm > CFG.WHO_24H).length;
  const thr = alertLevel(sc);
  const alertNow = rows.filter(r => r.pm > thr);
  const rising = rows.filter(r => r.pm <= thr && r.peak24 > thr).sort((a, b) => b.peak24 - a.peak24);
  const tabs = { worst: [...rows].sort((a, b) => b.pm - a.pm), rising, clean: [...rows].sort((a, b) => a.pm - b.pm) };
  const list = tabs[state.worldTab].slice(0, 12);
  v.innerHTML = `
  <section class="panel">
    <p class="lead">Right now, the air in <b>${overWHO}</b> of ${rows.length} capital cities is above the WHO daily guideline for PM2.5, and <b>${alertNow.length}</b> are at a level where children should move outdoor activity indoors.${rising.length ? ` <b>${rising.length}</b> more are forecast to get there in the next 24 hours.` : ""}</p>
    <div class="dist" role="img" aria-label="Capitals by air quality band">${counts.map(c => c.n ? `<i style="width:${c.n / rows.length * 100}%;background:${c.b.col}" title="${esc(c.b.name)}: ${c.n}"></i>` : "").join("")}</div>
    <div class="dist-legend">${counts.map(c => `<span><i style="background:${c.b.col}"></i>${esc(c.b.name)}<b>${c.n}</b></span>`).join("")}</div>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head"><h2>PM2.5 in each country's capital, now</h2><span class="note">Click a country to see its cities</span></div>
      <svg class="map" id="worldMap" role="img" aria-label="World map coloured by air quality"></svg>
      <div class="legend">${sc.bands.map((b, i) => `<span><i style="background:${b.col}"></i>${esc(b.name)} (${b.max < 1e8 ? "≤" + b.max : "&gt;" + sc.bands[i - 1].max})</span>`).join("")}<span><i style="background:var(--nodata)"></i>No data</span></div>
      <p class="note">Scale: ${esc(sc.name)}, µg/m³. Small countries are shown as dots.</p>
    </section>
    <section class="panel">
      <div class="tabs" role="tablist">
        ${[["worst", "Worst now"], ["rising", `Getting worse (${rising.length})`], ["clean", "Cleanest"]].map(([k, t]) => `<button type="button" role="tab" data-wtab="${k}" aria-selected="${state.worldTab === k}">${t}</button>`).join("")}
      </div>
      <div class="rows">${list.length ? list.map((r, i) => `
        <button type="button" class="row" data-go="${r.p.c}-${r.p.cities.findIndex(c => c[0] === r.p.cap[0])}">
          <span class="rk">${i + 1}</span>
          <span class="nm"><b>${esc(r.p.n)}</b><small>${esc(r.p.cap[0])}${state.worldTab === "rising" ? ` · peak ${fmt(r.peak24)} in next 24 h` : ""}</small></span>
          ${chip(state.worldTab === "rising" ? r.peak24 : r.pm, sc)}
          <span class="v">${fmt(r.pm)}<small>µg/m³</small></span>
        </button>`).join("") : `<p class="note" style="padding:8px">No capital is forecast to cross the alert level in the next 24 hours.</p>`}</div>
    </section>
  </div>`;
  drawWorldMap();
}
function drawWorldMap() {
  const svg = d3.select("#worldMap"), W = 960, H = 500, sc = worldScale(), data = state.world.byCC;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  const proj = d3.geoNaturalEarth1().fitExtent([[4, 4], [W - 4, H - 4]], { type: "Sphere" });
  const path = d3.geoPath(proj);
  svg.append("path").attr("d", path({ type: "Sphere" })).attr("fill", "var(--ocean)");
  svg.append("g").selectAll("path").data(FEATURES).join("path")
    .attr("class", d => "country" + (d.properties.cc ? "" : " dim")).attr("d", path)
    .attr("fill", d => { const r = data[d.properties.cc]; const b = r && band(r.pm, sc); return b ? b.col : "var(--nodata)"; })
    .on("mousemove", (ev, d) => tipCountry(ev, d.properties.cc, d.properties.name))
    .on("mouseleave", hideTip)
    .on("click", (ev, d) => { if (d.properties.cc && BY_CC[d.properties.cc]) location.hash = d.properties.cc; });
  const shown = new Set(FEATURES.map(f => f.properties.cc));
  const small = PLACES.filter(p => (p.a && p.a < 12000) || !shown.has(p.c));
  svg.append("g").selectAll("circle").data(small).join("circle").attr("class", "pt")
    .attr("cx", p => proj([p.cap[2], p.cap[1]])[0]).attr("cy", p => proj([p.cap[2], p.cap[1]])[1]).attr("r", 3.4)
    .attr("fill", p => { const b = band(data[p.c]?.pm, sc); return b ? b.col : "var(--nodata)"; })
    .on("mousemove", (ev, p) => tipCountry(ev, p.c, p.n)).on("mouseleave", hideTip)
    .on("click", (ev, p) => { location.hash = p.c; });
}
function tipCountry(ev, cc, name) {
  const p = BY_CC[cc], r = state.world?.byCC[cc], sc = worldScale();
  if (!p || !r) return showTip(ev, `<b>${esc(name)}</b><br>No live data`);
  const b = band(r.pm, sc);
  showTip(ev, `<b>${esc(p.n)}</b><br>${esc(p.cap[0])}: <b>${fmt(r.pm)}</b> µg/m³ · ${esc(b?.name || "")}<br>Next 24 h peak: ${fmt(r.peak24)} µg/m³`);
}
function showTip(ev, html) { const t = $("tip"); t.innerHTML = html; t.hidden = false; const x = Math.min(ev.clientX + 14, innerWidth - 270); t.style.left = x + "px"; t.style.top = (ev.clientY + 14) + "px"; }
function hideTip() { $("tip").hidden = true; }

/* ---------- country */
function renderCountry() {
  const v = $("view"), p = BY_CC[state.cc], C = state.country, sc = scaleFor(p.c);
  if (!C || C.cities.length !== p.cities.length) { v.innerHTML = `<div class="panel"><p class="skeleton">Loading live air quality for ${p.cities.length} cities in ${esc(p.n)}…</p></div>`; return; }
  const rows = p.cities.map((c, i) => ({ c, i, ...C.cities[i] })).filter(r => r.pm != null).sort((a, b) => b.pm - a.pm);
  const thr = alertLevel(sc);
  const bad = rows.filter(r => r.pm > thr), rising = rows.filter(r => r.pm <= thr && r.peak24 > thr);
  const worst = rows[0], best = rows[rows.length - 1];
  v.innerHTML = `
  <section class="panel">
    <p class="lead">${rows.length > 1 ? `In ${esc(p.n)}, <b>${bad.length}</b> of ${rows.length} major cities are at the alert level or worse right now${rising.length ? `, and <b>${rising.length}</b> more will be within 24 hours` : ""}. Worst: <b>${esc(worst.c[0])}</b> at ${fmt(worst.pm)} µg/m³; cleanest: ${esc(best.c[0])} at ${fmt(best.pm)} µg/m³.`
      : `${esc(worst.c[0])}, ${esc(p.n)}: PM2.5 is ${fmt(worst.pm)} µg/m³ right now.`}</p>
    <p class="note">Scale: ${esc(sc.name)}. Alert level: above ${thr} µg/m³ (${esc(sc.bands.find(b => b.lvl >= 2).name)}).</p>
  </section>
  <div class="grid2">
    <section class="panel">
      <div class="panel-head"><h2>Major cities, now</h2><span class="note">Click a city for the full picture</span></div>
      <svg class="map" id="cMap" role="img" aria-label="Map of ${esc(p.n)} cities"></svg>
      <div class="legend">${sc.bands.map(b => `<span><i style="background:${b.col}"></i>${esc(b.name)}</span>`).join("")}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Ranked by PM2.5</h2><span class="note">µg/m³</span></div>
      <div class="rows">${rows.map((r, k) => `
        <button type="button" class="row" data-go="${p.c}-${r.i}">
          <span class="rk">${k + 1}</span>
          <span class="nm"><b>${esc(r.c[0])}${r.c[0] === p.cap[0] ? " ★" : ""}</b><small>Next 24 h peak ${fmt(r.peak24)}${r.c[3] ? ` · ${fmt(r.c[3] / 1e6, 1)} M people` : ""}</small></span>
          ${chip(r.pm, sc)}<span class="v">${fmt(r.pm)}</span>
        </button>`).join("")}</div>
      <p class="note">★ capital</p>
    </section>
  </div>`;
  drawCountryMap(p, rows, sc);
}
function drawCountryMap(p, rows, sc) {
  const svg = d3.select("#cMap"), W = 760, H = 520;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  const pad = p.cities.length > 2 ? 1.2 : 3;
  const circles = p.cities.map(c => d3.geoCircle().center([c[2], c[1]]).radius(pad)());
  const proj = d3.geoMercator().fitExtent([[20, 20], [W - 20, H - 20]], { type: "GeometryCollection", geometries: circles });
  const path = d3.geoPath(proj);
  svg.append("rect").attr("width", W).attr("height", H).attr("fill", "var(--ocean)");
  svg.append("g").selectAll("path").data(FEATURES).join("path").attr("d", path)
    .attr("class", d => "country" + (d.properties.cc === p.c ? " sel" : " dim"))
    .attr("fill", d => d.properties.cc === p.c ? "var(--land)" : "var(--nodata)")
    .on("click", (ev, d) => { if (d.properties.cc && d.properties.cc !== p.c && BY_CC[d.properties.cc]) location.hash = d.properties.cc; });
  const maxPop = Math.max(...p.cities.map(c => c[3] || 1));
  const g = svg.append("g");
  [...rows].reverse().forEach(r => {
    const [x, y] = proj([r.c[2], r.c[1]]); const b = band(r.pm, sc);
    g.append("circle").attr("class", "pt").attr("cx", x).attr("cy", y).attr("r", 5 + 9 * Math.sqrt((r.c[3] || 1) / maxPop))
      .attr("fill", b ? b.col : "var(--nodata)")
      .on("mousemove", ev => showTip(ev, `<b>${esc(r.c[0])}</b><br>PM2.5 <b>${fmt(r.pm)}</b> µg/m³ · ${esc(b?.name || "")}<br>Next 24 h peak ${fmt(r.peak24)}`))
      .on("mouseleave", hideTip).on("click", () => { location.hash = `${p.c}-${r.i}`; });
  });
  rows.slice(0, 8).forEach(r => { const [x, y] = proj([r.c[2], r.c[1]]); g.append("text").attr("class", "city").attr("x", x + 10).attr("y", y + 4).text(r.c[0]); });
}

/* ---------- city */
function renderCity() {
  const v = $("view"), c = cityRef(), p = BY_CC[c.cc], A = state.cityA;
  if (!A || !state.city) { v.innerHTML = `<div class="panel"><p class="skeleton">Loading live air quality and 3-day forecast for ${esc(c.name)}…</p></div>`; return; }
  const sc = A.scale, b = band(A.cur, sc), lvl = b.lvl;
  const localNow = parseLocal(A.nowStr);
  const ratio = A.cur / CFG.WHO_24H;
  v.innerHTML = `
  <div class="hero">
    <section class="status" style="--sbg:${b.col};--sfg:${b.fg}">
      <span class="where">${esc(c.name)}, ${esc(p.n)} · local time ${hhmm(localNow.h)} ${DOW[localNow.dow]}</span>
      <h1>${esc(b.name)}</h1>
      <div class="big"><b>${fmt(A.cur)}</b><span>µg/m³ PM2.5 now<br>${ratio >= 1.5 ? `${fmt(ratio, 1)}× the WHO daily guideline` : ratio > 1 ? "just above the WHO daily guideline" : "within the WHO daily guideline"}</span></div>
      <p class="advice">${esc(LEVEL_TEXT[lvl])}</p>
      <p class="meta">${esc(sc.name)} · model value for this area, refreshed ${timeAgo(state.city.t)}</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Next days</h2><span class="note">daily worst hour</span></div>
      <div class="days">${A.days.map((d, i) => { const db = band(d.max, sc); return `<div class="day"><span class="label">${i === 0 ? "Today" : DOW[parseLocal(d.t).dow]}</span><b>${fmt(d.max)}</b><span class="bar" style="background:${db.col}"></span><small>${esc(db.name)} · avg ${fmt(d.avg)}</small></div>`; }).join("")}</div>
      ${A.best ? `<div class="callout ok"><span><b>Best time outdoors:</b> ${esc(whenLabel(A.T[A.best.i], A.nowStr))}–${hhmm((parseLocal(A.T[A.best.i]).h + 2) % 24)}, PM2.5 about ${fmt(A.best.v)} µg/m³.</span><span class="note">Lowest 2-hour daytime window in the next 36 hours. Plan sport, walks and outdoor classes here.</span></div>` : ""}
    </section>
  </div>
  ${stepDetect(A, c)}
  ${stepExplain(A, c)}
  ${stepAct(A, c, p)}
  ${stepMeasure(A)}
  ${stepPlant(A, c)}`;
  drawChart(A);
  drawSiteMap(A);
}
function eventSentence(A) {
  const ev = A.focus; if (!ev) return null;
  const pb = band(ev.peak, A.scale);
  const endTxt = ev.open ? "beyond the forecast" : whenLabel(A.T[Math.min(A.T.length - 1, ev.e + 1)], A.nowStr);
  return A.active
    ? `<b>Alert now.</b> PM2.5 has been above ${A.thr} µg/m³ since ${esc(whenLabel(A.T[ev.s], A.nowStr))} and should ease around ${esc(endTxt)}. Peak: ${fmt(ev.peak)} µg/m³ (${esc(pb.name)}) at ${esc(whenLabel(A.T[ev.pi], A.nowStr))}.`
    : `<b>Alert coming.</b> PM2.5 is forecast to pass ${A.thr} µg/m³ from ${esc(whenLabel(A.T[ev.s], A.nowStr))} to ${esc(endTxt)}, peaking at ${fmt(ev.peak)} µg/m³ (${esc(pb.name)}).`;
}
function stepDetect(A) {
  const s = eventSentence(A);
  return `<section class="panel step"><span class="step-no">1</span><div class="step-body">
    <h2>Detect: is the air dangerous?<small>Past 24 hours and the next 3 days, hour by hour</small></h2>
    ${s ? `<div class="callout alarm">${s}</div>` : `<div class="callout ok"><b>No alert in the next 48 hours.</b><span>PM2.5 stays at or below ${A.thr} µg/m³, the level where children's outdoor activity should move indoors.</span></div>`}
    <svg class="chart" id="chart" role="img" aria-label="Hourly PM2.5 chart"></svg>
    <p class="note">Shaded bands follow ${esc(A.scale.name)}. Dashed line: alert level (${A.thr} µg/m³). Red bar under the chart: alert periods.</p>
  </div></section>`;
}
function drawChart(A) {
  const svg = d3.select("#chart"), W = Math.max(320, Math.min(1000, svg.node().getBoundingClientRect().width || 1000)), H = W < 600 ? 240 : 280, m = { l: 40, r: 10, t: 12, b: 40 };
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  const n = A.T.length, vals = A.pm.filter(v => v != null);
  const yMax = Math.max(A.thr * 1.4, d3.max(vals) * 1.1);
  const x = d3.scaleLinear().domain([0, n - 1]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, yMax]).range([H - m.b, m.t]);
  let lo = 0;
  A.scale.bands.forEach(b => { const hi = Math.min(b.max, yMax); if (hi > lo) svg.append("rect").attr("x", m.l).attr("width", W - m.l - m.r).attr("y", y(hi)).attr("height", y(lo) - y(hi)).attr("fill", b.col).attr("opacity", .16); lo = b.max; });
  y.ticks(5).forEach(t => { svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", "var(--line)"); svg.append("text").attr("x", m.l - 6).attr("y", y(t) + 4).attr("text-anchor", "end").text(t); });
  A.T.forEach((t, i) => { const p = parseLocal(t); if (p.h === 0) { svg.append("line").attr("x1", x(i)).attr("x2", x(i)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--line)"); svg.append("text").attr("class", "lbl").attr("x", x(i) + 4).attr("y", H - 22).text(whenLabel(t, A.nowStr).split(" ")[0]); } else if (p.h === 12 && W >= 600) svg.append("text").attr("x", x(i)).attr("y", H - 22).attr("text-anchor", "middle").text("12:00"); });
  svg.append("rect").attr("x", x(A.now)).attr("width", W - m.r - x(A.now)).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "var(--surface)").attr("opacity", .35);
  svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(A.thr)).attr("y2", y(A.thr)).attr("stroke", "var(--ink)").attr("stroke-dasharray", "5 4");
  A.events.forEach(e => svg.append("rect").attr("x", x(e.s)).attr("width", Math.max(3, x(e.e) - x(e.s))).attr("y", H - m.b + 4).attr("height", 6).attr("rx", 3).attr("fill", "var(--alarm)"));
  if (A.best) svg.append("rect").attr("x", x(A.best.i)).attr("width", x(A.best.i + 1) - x(A.best.i)).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "#2fa35a").attr("opacity", .22);
  const line = d3.line().defined(v => v != null).x((v, i) => x(i)).y(v => y(v));
  svg.append("path").attr("d", line(A.pm.slice(0, A.now + 1))).attr("fill", "none").attr("stroke", "var(--ink)").attr("stroke-width", 2.2);
  svg.append("path").attr("d", line(A.pm.map((v, i) => i < A.now ? null : v))).attr("fill", "none").attr("stroke", "var(--ink)").attr("stroke-width", 2.2).attr("stroke-dasharray", "2 3");
  svg.append("line").attr("x1", x(A.now)).attr("x2", x(A.now)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--ink)");
  svg.append("text").attr("class", "lbl").attr("x", x(A.now) + 5).attr("y", m.t + 12).attr("style", "fill:var(--ink)").text("now");
  svg.append("text").attr("class", "lbl").attr("x", x(A.now) + 5).attr("y", m.t + 26).text("forecast →");
  svg.append("circle").attr("cx", x(A.now)).attr("cy", y(A.pm[A.now] ?? 0)).attr("r", 4.5).attr("fill", "var(--ink)");
  svg.append("text").attr("x", 8).attr("y", m.t + 4).attr("transform", `rotate(-90 8 ${m.t + 4})`).attr("text-anchor", "end").text("µg/m³");
  // hover
  const cross = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--muted)").attr("visibility", "hidden");
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.b - m.t).attr("fill", "transparent")
    .on("mousemove", ev => { const [mx] = d3.pointer(ev); const i = Math.max(0, Math.min(n - 1, Math.round(x.invert(mx)))); cross.attr("x1", x(i)).attr("x2", x(i)).attr("visibility", "visible");
      const b = band(A.pm[i], A.scale); showTip(ev, `<b>${esc(whenLabel(A.T[i], A.nowStr))}</b>${i > A.now ? " (forecast)" : ""}<br>PM2.5 <b>${fmt(A.pm[i])}</b> µg/m³ · ${esc(b?.name || "")}${A.wind[i] != null ? `<br>Wind ${fmt(A.wind[i], 1)} m/s` : ""}${A.blh[i] != null ? ` · mixing ${fmt(A.blh[i])} m` : ""}`); })
    .on("mouseleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
}
function stepExplain(A, c) {
  const cs = A.cause, s = cs.signals;
  const S = state.sites;
  const when = A.focus ? `at the ${A.active ? "current" : "coming"} peak (${whenLabel(A.T[A.focus.pi], A.nowStr)})` : "right now";
  let who;
  if (state.sitesErr) who = `<div class="callout info"><b>Couldn't load schools and hospitals from OpenStreetMap.</b><span>${esc(state.sitesErr)}. <button class="btn" type="button" data-act="sites">Try again</button></span></div>`;
  else if (!S) who = `<p class="skeleton">Finding schools, colleges, hospitals and clinics within ${CFG.SITE_RADIUS_M / 1000} km of the city centre…</p>`;
  else {
    const n = t => S.sites.filter(x => SITE_GROUP[x.type] === t);
    const edu = n("edu"), hea = n("health");
    const pe = edu.reduce((a, x) => a + x.people, 0), ph = hea.reduce((a, x) => a + x.people, 0);
    const near = S.sites.filter(x => x.roadDist <= 60);
    who = `<div class="who">
      <div style="display:grid;gap:10px;align-content:start">
        <div class="counts">
          <div class="count"><span class="label">Schools &amp; colleges</span><b>${edu.length}</b><small>about ${fmt(pe)} students</small></div>
          <div class="count"><span class="label">Hospitals &amp; clinics</span><b>${hea.length}</b><small>about ${fmt(ph)} patients</small></div>
        </div>
        <p class="note">Within ${CFG.SITE_RADIUS_M / 1000} km of the centre of ${esc(c.name)}, from OpenStreetMap. <b>${near.length}</b> sit within 60 m of a major road, where traffic pollution is highest. Head counts use OpenStreetMap capacity where mapped, otherwise typical sizes.</p>
        ${S.sites.length === 0 ? `<p class="note">OpenStreetMap has no schools or hospitals mapped here yet.</p>` : ""}
      </div>
      <svg class="sitemap" id="siteMap" role="img" aria-label="Map of schools, hospitals and major roads"></svg>
    </div>`;
  }
  return `<section class="panel step"><span class="step-no">2</span><div class="step-body">
    <h2>Explain: why, and who is at risk?<small>Likely cause from live model signals ${esc(when)}</small></h2>
    <div class="callout info"><b>Likely cause: ${esc(cs.cause)}</b><span>${esc(cs.why)}</span></div>
    <div class="signals">
      <div class="sig"><span class="label">Wind</span><b>${s.wind != null ? fmt(s.wind, 1) + " m/s" : "–"}</b><small>${s.wind == null ? "not available" : s.wind < 2 ? "still: pollution builds up" : s.wind < 5 ? "light breeze" : "windy: pollution disperses"}</small></div>
      <div class="sig"><span class="label">Mixing height</span><b>${s.blh != null ? fmt(s.blh) + " m" : "–"}</b><small>${s.blh == null ? "not available" : s.blh < 300 ? "low lid: air is trapped" : s.blh < 1000 ? "moderate" : "deep: air mixes well"}</small></div>
      <div class="sig"><span class="label">Dust share of PM10</span><b>${s.dust != null && s.pm10 ? Math.round(s.dust / s.pm10 * 100) + "%" : "–"}</b><small>high share means desert dust</small></div>
      <div class="sig"><span class="label">Carbon monoxide</span><b>${s.co != null ? fmt(s.co) : "–"}</b><small>µg/m³; high means burning or traffic</small></div>
    </div>
    <h3 style="font-size:16px">Who is exposed</h3>
    ${who}
  </div></section>`;
}
function drawSiteMap(A) {
  const S = state.sites, el = $("siteMap"); if (!S || !el) return;
  const svg = d3.select(el), W = 420, H = 420, R = CFG.SITE_RADIUS_M;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  const k = (W / 2 - 14) / R, X = p => W / 2 + p[0] * k, Y = p => H / 2 - p[1] * k;
  svg.append("circle").attr("cx", W / 2).attr("cy", H / 2).attr("r", R * k).attr("fill", "var(--surface)").attr("stroke", "var(--line)");
  svg.append("defs").append("clipPath").attr("id", "clipR").append("circle").attr("cx", W / 2).attr("cy", H / 2).attr("r", R * k);
  const g = svg.append("g").attr("clip-path", "url(#clipR)");
  S.green.forEach(p => g.append("circle").attr("cx", X(p)).attr("cy", Y(p)).attr("r", 5).attr("fill", "#2fa35a").attr("opacity", .35));
  S.roads.forEach(r => g.append("path").attr("d", d3.line().x(X).y(Y)(r.pts)).attr("fill", "none").attr("stroke", "var(--rust)").attr("stroke-width", 2).attr("opacity", .7));
  S.sites.forEach(s => {
    const edu = SITE_GROUP[s.type] === "edu";
    g.append(edu ? "circle" : "rect").call(sel => edu ? sel.attr("cx", X(s.xy)).attr("cy", Y(s.xy)).attr("r", 4.5) : sel.attr("x", X(s.xy) - 4).attr("y", Y(s.xy) - 4).attr("width", 8).attr("height", 8))
      .attr("fill", s.roadDist <= 60 ? "var(--alarm)" : "var(--ink)").attr("stroke", "var(--surface)").attr("stroke-width", 1)
      .on("mousemove", ev => showTip(ev, `<b>${esc(s.name)}</b><br>${SITE[s.type].label} · ~${fmt(s.people)} ${SITE[s.type].who}<br>${isFinite(s.roadDist) ? `${fmt(s.roadDist)} m from ${esc(s.road || "a major road")}` : "no major road nearby"}`))
      .on("mouseleave", hideTip);
  });
  svg.append("text").attr("x", 10).attr("y", H - 26).attr("style", "font-size:11px;fill:var(--muted);font-family:var(--f-body)").text("● school/college  ■ hospital/clinic  red = within 60 m of major road");
  svg.append("text").attr("x", 10).attr("y", H - 10).attr("style", "font-size:11px;fill:var(--muted);font-family:var(--f-body)").text("brown lines: major roads · green: parks and woods · circle: 2 km");
}
function actionsFor(lvl, cause) {
  const school = lvl >= 4 ? ["Consider closing or moving to online classes.", "Keep all children indoors with windows closed.", "Run air purifiers in classrooms if available."]
    : lvl >= 3 ? ["Cancel outdoor PE, sports and assembly.", "Keep children indoors at break times.", "Close road-facing windows during peak hours.", "Shift dismissal away from the peak hour; children walking home should wear N95 masks."]
    : lvl >= 2 ? ["Move PE, sports and assembly indoors.", "Close road-facing windows during peak hours.", "Let children with asthma skip strenuous activity."]
    : lvl >= 1 ? ["Let children with asthma or allergies skip strenuous outdoor PE.", "Make sure reliever inhalers are at hand."]
    : ["No changes needed. A good day for outdoor activity."];
  const health = lvl >= 3 ? ["Keep windows closed; run air purifiers in wards with lung or heart patients.", "Move outpatient queues indoors.", "Prepare for more asthma and COPD visits."]
    : lvl >= 2 ? ["Keep windows closed in wards with lung or heart patients.", "Bring outpatient queues indoors.", "Tell patients with asthma or COPD to keep reliever medication at hand."]
    : lvl >= 1 ? ["Remind patients with lung or heart conditions to limit time outdoors."] : ["No changes needed."];
  const people = lvl >= 4 ? ["Stay indoors with windows closed.", "Wear an N95 mask if you must go out.", "Avoid all outdoor exercise."]
    : lvl >= 3 ? ["Avoid outdoor exercise; move it indoors or to the best window.", "Wear an N95 mask outdoors.", "Keep windows closed at peak hours."]
    : lvl >= 2 ? ["Cut long or heavy outdoor exercise, especially near traffic.", "Sensitive groups: stay indoors at peak hours."]
    : lvl >= 1 ? ["Sensitive groups: take it easier outdoors.", "Use the best outdoor window for exercise."] : ["Enjoy being outside."];
  const city = lvl >= 1 ? [cause.source] : ["Keep monitoring; no source action needed today."];
  return { school, health, people, city };
}
function stepAct(A, c, p) {
  const ev = A.focus, lvl = ev ? band(ev.peak, A.scale).lvl : band(A.cur, A.scale).lvl;
  const acts = actionsFor(lvl, A.cause);
  const S = state.sites;
  let sites = "";
  if (S && S.sites.length && ev) {
    const ranked = S.sites.map(s => ({ s, x: exposureFor(s, A, ev) })).sort((a, b) => (b.x.ph - a.x.ph) || (a.s.roadDist - b.s.roadDist));
    const list = state.showAllSites ? ranked : ranked.slice(0, 6);
    sites = `<h3 style="font-size:16px">Mark sites as they act</h3>
      <div class="sites">${list.map(({ s, x }) => { const key = `${A.T[ev.s]}|${s.id}`; return `<div class="site">
        <b>${esc(s.name)}</b>
        <small>${SITE[s.type].label} · ~${fmt(s.people)} ${SITE[s.type].who}${isFinite(s.roadDist) && s.roadDist <= 200 ? ` · ${fmt(s.roadDist)} m from ${esc(s.road || "major road")}` : ""} · ${x.closed ? "closed during the alert hours" : `saves ~${fmt(x.cut)}% of exposure`}</small>
        <label class="toggle"><input type="checkbox" data-done="${esc(key)}" ${state.done[key] ? "checked" : ""}> Done</label></div>`; }).join("")}</div>
      ${ranked.length > 6 ? `<button type="button" class="btn more" data-act="allsites">${state.showAllSites ? "Show fewer" : `Show all ${ranked.length} sites`}</button>` : ""}`;
  }
  const head = ev ? `For the ${A.active ? "current" : "coming"} alert, peaking at ${esc(band(ev.peak, A.scale).name.toLowerCase())}` : `For today's air: ${esc(band(A.cur, A.scale).name.toLowerCase())}`;
  return `<section class="panel step"><span class="step-no">3</span><div class="step-body">
    <h2>Act: what to do<small>${head}</small></h2>
    <div class="acts">
      <div class="act"><h3><i>S</i>Schools &amp; colleges</h3><ul>${acts.school.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>
      <div class="act"><h3><i>H</i>Hospitals &amp; clinics</h3><ul>${acts.health.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>
      <div class="act"><h3><i>P</i>Everyone</h3><ul>${acts.people.map(a => `<li>${esc(a)}</li>`).join("")}${A.best ? `<li>Best time outdoors: ${esc(whenLabel(A.T[A.best.i], A.nowStr))}.</li>` : ""}</ul></div>
      <div class="act"><h3><i>C</i>City officials</h3><ul>${acts.city.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>
    </div>
    ${sites}
  </div></section>`;
}
function stepMeasure(A) {
  const ev = A.focus, S = state.sites;
  let body;
  if (!ev) body = `<div class="callout ok"><b>Nothing to measure yet.</b><span>When an alert is forecast, this step estimates how much PM2.5 exposure the actions above save at each school and hospital, and tracks how many sites have acted.</span></div>`;
  else if (!S) body = `<p class="skeleton">Waiting for the list of schools and hospitals…</p>`;
  else {
    const rows = S.sites.map(s => ({ s, x: exposureFor(s, A, ev) })).filter(r => r.x.ph > 0);
    const total = rows.reduce((a, r) => a + r.x.ph, 0);
    const done = rows.filter(r => state.done[`${A.T[ev.s]}|${r.s.id}`]);
    const doneTotal = done.reduce((a, r) => a + r.x.ph, 0);
    const cut = rows.length ? mean(rows.map(r => r.x.cut)) : 0;
    body = `<div class="measure">
      <div class="m"><span class="label">If every site acts</span><b>${fmt(total)}</b><small>person-hours moved indoors during the alert</small></div>
      <div class="m"><span class="label">Exposure cut</span><b>${fmt(cut)}%</b><small>less PM2.5 breathed per person during the alert, on average</small></div>
      <div class="m"><span class="label">Confirmed so far</span><b>${done.length}/${rows.length}</b><small>${fmt(doneTotal)} person-hours, ticked in step 3</small></div>
    </div>
    <p class="note">How this is worked out: for each site open during the alert hours (school 08–16, college 09–17, clinic 08–20, hospital all day, local time), the outdoor time an action moves indoors (schools 1.5 h, colleges 1 h, health sites 0.5 h) is breathed at ${CFG.IO_RATIO}× the outdoor level with windows closed. Indoor/outdoor ratios of roughly 0.4–0.9 are reported in studies. Assumes a normal working day. Ticks are saved in this browser only.</p>`;
  }
  return `<section class="panel step"><span class="step-no">4</span><div class="step-body">
    <h2>Measure: what does it save?<small>Estimated exposure avoided, if the actions are followed</small></h2>
    ${body}
  </div></section>`;
}
function stepPlant(A, c) {
  const S = state.sites;
  let body;
  if (!S) body = `<p class="skeleton">Waiting for schools, roads and parks from OpenStreetMap…</p>`;
  else if (!S.sites.length) body = `<p class="note">No schools or hospitals are mapped in OpenStreetMap near the centre of ${esc(c.name)}, so there is nothing to rank yet.</p>`;
  else {
    const ranked = S.sites.map(s => ({ s, g: greenGap(s, A) })).sort((a, b) => b.g.score - a.g.score).slice(0, 5);
    const g0 = ranked[0].g;
    const india = c.cc === "IN";
    body = `<p>Over the last 24 hours PM2.5 averaged <b>${fmt(A.mean24)} µg/m³</b>, ${A.mean24 > CFG.WHO_24H ? `<b>${fmt(A.mean24 - CFG.WHO_24H)}</b> above` : "within"} the WHO daily guideline of ${CFG.WHO_24H}. Trees and hedges help most where many people meet traffic pollution with little greenery around. These are the sites where planting protects the most people:</p>
    ${ranked.map(({ s, g }, i) => {
      const open = s.roadDist <= 60;
      const layout = open ? [`A continuous, dense hedge (1.5–2 m) between ${esc(s.road || "the road")} and the ${SITE[s.type].label.toLowerCase()}, with no gaps.`, "A second row of medium evergreen trees behind it, 5–6 m apart.", "Make the barrier longer than the building so polluted air can't wrap around the ends."]
        : s.roadDist <= 200 ? ["A hedge along the boundary that faces the nearest busy road.", "Shade trees in the grounds and along the entrance path."]
        : ["Shade trees in open ground and along entrance paths.", "Hedges along boundaries that face streets with traffic."];
      return `<div class="plan"><div class="plan-head"><b>${i + 1}. ${esc(s.name)}</b><span class="note">${SITE[s.type].label} · ~${fmt(s.people)} ${SITE[s.type].who} · ${isFinite(s.roadDist) ? `${fmt(s.roadDist)} m from a major road` : "no major road within 2 km"} · ${s.greenNear} green spaces within 300 m</span></div>
        <ul>${layout.map(l => `<li>${l}</li>`).join("")}</ul>
        ${open ? `<div class="avoid"><b>Avoid</b> gappy single rows of trees, and tall trees with closed crowns over narrow streets lined with buildings: both can trap exhaust at breathing height.</div>` : ""}
        <p class="note">Plant up to <b>${fmt(Math.min(g.trees, g.fit))}</b> trees in this 250 m block (about ${g.fit} fit in 5% of the area). Its PM2.5 burden equals the yearly cleaning of about <b>${fmt(g.trees)}</b> trees.</p>
      </div>`; }).join("")}
    <div class="formula">Tree-equivalent per 250 m block = (<b>${fmt(g0.excess, 1)}</b> µg/m³ above WHO × <b>62,500</b> m² × <b>${fmt(g0.blh)}</b> m mixing height${g0.blhLive ? " (live, 24 h average)" : " (default)"} × 10⁻⁶) ÷ <b>${CFG.TREE_G_YR}</b> g per tree per year = <b>${fmt(g0.trees)}</b> trees</div>
    <p class="note">${india ? `Species suited to Indian streets: ${INDIA_SPECIES.join(", ")}. Confirm with the local forest or horticulture department.` : "Choose native species of each type: dense evergreen shrubs for hedges, and medium evergreen trees with small, rough or hairy leaves, which catch more particles. Ask the local forestry or parks department for a shortlist."} The tree-equivalent is an awareness figure: trees cut exposure close to them, but cutting the source matters most. The removal rate of ${CFG.TREE_G_YR} g per tree per year is a placeholder based on Nowak et al. (2013); replace it with a locally cited value.</p>`;
  }
  return `<section class="panel step"><span class="step-no plant">5</span><div class="step-body">
    <h2>Long term: where to plant<small>Green Gap: pollution × people × traffic exposure × missing greenery</small></h2>
    ${body}
  </div></section>`;
}

/* ------------------------------------------------------------------ search + location */
const SEARCH = [];
PLACES.forEach(p => {
  SEARCH.push({ k: p.n.toLowerCase(), label: p.n, sub: "Country", go: p.c });
  p.cities.forEach((c, i) => SEARCH.push({ k: c[0].toLowerCase(), label: c[0], sub: p.n, go: `${p.c}-${i}`, pop: c[3] }));
});
let qSel = 0;
function searchResults(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const scored = [];
  for (const s of SEARCH) { const i = s.k.indexOf(q); if (i < 0) continue; scored.push({ s, r: (i === 0 ? 0 : 1) * 1e10 + (s.sub === "Country" ? 0 : 1e9 - (s.pop || 0) / 10) }); }
  return scored.sort((a, b) => a.r - b.r).slice(0, 8).map(x => x.s);
}
function drawResults() {
  const q = $("q").value, res = searchResults(q), box = $("qres");
  if (!q.trim()) { box.hidden = true; $("q").setAttribute("aria-expanded", "false"); return; }
  box.hidden = false; $("q").setAttribute("aria-expanded", "true");
  box.innerHTML = res.length ? res.map((s, i) => `<button type="button" role="option" aria-selected="${i === qSel}" data-go="${s.go}"><span>${esc(s.label)}</span><small>${esc(s.sub)}</small></button>`).join("")
    : `<p class="note" style="padding:10px 12px">No match. Try a country or a larger city nearby.</p>`;
}
$("q").addEventListener("input", () => { qSel = 0; drawResults(); });
$("q").addEventListener("keydown", e => {
  const res = searchResults($("q").value);
  if (e.key === "ArrowDown") { qSel = Math.min(res.length - 1, qSel + 1); drawResults(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { qSel = Math.max(0, qSel - 1); drawResults(); e.preventDefault(); }
  else if (e.key === "Enter" && res[qSel]) { go(res[qSel].go); }
  else if (e.key === "Escape") { $("q").value = ""; drawResults(); }
});
document.addEventListener("click", e => { if (!e.target.closest(".search")) $("qres").hidden = true; });
function go(h) { $("q").value = ""; $("qres").hidden = true; location.hash = h; if (decodeURIComponent(location.hash.slice(1)) === h) window.scrollTo({ top: 0 }); }

$("locBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return alertMsg("This browser can't share your location. Search for your city instead.");
  $("locBtn").disabled = true;
  navigator.geolocation.getCurrentPosition(pos => {
    $("locBtn").disabled = false;
    const { latitude: lat, longitude: lon } = pos.coords;
    let best = null;
    PLACES.forEach(p => p.cities.forEach((c, i) => { const d = (c[1] - lat) ** 2 + ((c[2] - lon) * Math.cos(lat * Math.PI / 180)) ** 2; if (!best || d < best.d) best = { d, p, i, c }; }));
    state.here = { name: `Your location (near ${best.c[0]})`, lat: +lat.toFixed(3), lon: +lon.toFixed(3), cc: best.p.c };
    state.sites = null;
    if (location.hash === "#here") route(); else location.hash = "here";
  }, err => { $("locBtn").disabled = false; alertMsg(err.code === 1 ? "Location permission was refused. Search for your city instead." : "Couldn't get your location. Search for your city instead."); }, { timeout: 15000, maximumAge: 600000 });
});
function alertMsg(t) { const b = $("banner"); b.hidden = false; b.innerHTML = `<span>${esc(t)}</span>`; setTimeout(() => { if (!state.error) b.hidden = true; }, 6000); }

/* ------------------------------------------------------------------ events */
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]"); if (g) { go(g.dataset.go); return; }
  const a = e.target.closest("[data-act]");
  if (a) {
    if (a.dataset.act === "refresh") refresh(true);
    if (a.dataset.act === "allsites") { state.showAllSites = !state.showAllSites; render(); }
    if (a.dataset.act === "sites") { const c = cityRef(); try { localStorage.removeItem(`a2g:sites:${c.lat.toFixed(3)},${c.lon.toFixed(3)}`); } catch (_) {} state.sites = null; state.sitesErr = null; refresh(false); }
    return;
  }
  const t = e.target.closest("[data-wtab]"); if (t) { state.worldTab = t.dataset.wtab; renderWorld(); }
});
document.addEventListener("change", e => {
  const d = e.target.closest("[data-done]");
  if (d) { if (d.checked) state.done[d.dataset.done] = Date.now(); else delete state.done[d.dataset.done]; store.set("done", state.done); render(); }
});
$("scale").addEventListener("change", e => { state.scale = e.target.value; store.set("scale", state.scale); if (state.city) state.cityA = analyseCity(state.city, cityRef().cc); render(); });
window.addEventListener("hashchange", route);
window.A2G = { analyseCity, likelyCause, exposureFor, greenGap, band, SCALES, alertLevel, parseSites }; // for tests
route();
})();
