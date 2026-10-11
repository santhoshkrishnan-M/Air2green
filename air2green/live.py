"""Live data clients. No API keys needed.

- Open-Meteo air-quality API (CAMS): PM2.5, PM10, dust, carbon monoxide, hourly forecast
- Open-Meteo weather API: wind speed, boundary-layer (mixing) height
- OpenStreetMap Overpass API: schools, hospitals, major roads, parks
"""
from __future__ import annotations

import logging
import math

import requests

from . import config as C

log = logging.getLogger("air2green.live")
SESSION = requests.Session()
SESSION.headers["User-Agent"] = "AIR2GREEN/1.0 (hackathon prototype)"


def _get(url, params):
    r = SESSION.get(url, params=params, timeout=C.HTTP_TIMEOUT)
    if not r.ok:
        reason = ""
        try:
            reason = r.json().get("reason", "")
        except ValueError:
            pass
        raise RuntimeError(f"{url} -> HTTP {r.status_code} {reason}".strip())
    return r.json()


def air_multi(locs: list[tuple[float, float]], **params) -> list[dict]:
    """One Open-Meteo air-quality response per (lat, lon), in order."""
    out = []
    for i in range(0, len(locs), C.BATCH):
        part = locs[i:i + C.BATCH]
        j = _get(C.AQ_URL, {"latitude": ",".join(str(a) for a, _ in part),
                            "longitude": ",".join(str(b) for _, b in part), "timezone": "auto", **params})
        out.extend(j if isinstance(j, list) else [j])
    return out


def world_snapshot(places: list[dict]) -> list[dict]:
    """Current PM2.5 and next-24h peak at each place (e.g. every capital)."""
    res = air_multi([(p["lat"], p["lon"]) for p in places], current="pm2_5,pm10", hourly="pm2_5", forecast_hours=24)
    out = []
    for p, r in zip(places, res):
        hp = [v for v in (r.get("hourly", {}).get("pm2_5") or []) if v is not None]
        out.append({**p, "pm25": (r.get("current") or {}).get("pm2_5"), "peak24": max(hp) if hp else None,
                    "time": (r.get("current") or {}).get("time"), "timezone": r.get("timezone")})
    return out


def city_series(lat: float, lon: float) -> dict:
    """Past 24 h + next 4 days, hourly, in local time, air quality merged with weather."""
    common = {"latitude": lat, "longitude": lon, "timezone": "auto", "past_days": 1, "forecast_days": 4}
    aq = _get(C.AQ_URL, {**common, "current": "pm2_5,pm10,dust,carbon_monoxide",
                         "hourly": "pm2_5,pm10,dust,carbon_monoxide"})
    try:
        wx = _get(C.WX_URL, {**common, "hourly": "wind_speed_10m,boundary_layer_height", "wind_speed_unit": "ms"})
    except Exception as e:  # noqa: BLE001 - weather is optional context
        log.warning("weather fetch failed: %s", e)
        wx = {}
    return merge_series(aq, wx)


def merge_series(aq: dict, wx: dict) -> dict:
    h = aq["hourly"]
    wxh = (wx or {}).get("hourly") or {}
    idx = {t: i for i, t in enumerate(wxh.get("time", []))}
    pick = lambda key: [wxh.get(key, [None] * len(idx))[idx[t]] if t in idx else None for t in h["time"]]  # noqa: E731
    now_str = ((aq.get("current") or {}).get("time") or h["time"][0])[:13] + ":00"
    now = h["time"].index(now_str) if now_str in h["time"] else min(24, len(h["time"]) - 1)
    return {"time": h["time"], "pm25": h["pm2_5"], "pm10": h.get("pm10"), "dust": h.get("dust"),
            "co": h.get("carbon_monoxide"), "wind": pick("wind_speed_10m"), "blh": pick("boundary_layer_height"),
            "now": now, "current": (aq.get("current") or {}).get("pm2_5"), "timezone": aq.get("timezone"),
            "utc_offset_seconds": aq.get("utc_offset_seconds")}


# ------------------------------------------------------------------ Overpass
def sites_query(lat, lon, r=None):
    r = r or C.SITE_RADIUS_M
    return f"""[out:json][timeout:30];
nwr["amenity"~"^(school|kindergarten|college|university|hospital|clinic)$"](around:{r},{lat},{lon});
out center tags 400;
way["highway"~"^(motorway|trunk|primary)$"](around:{r},{lat},{lon});
out geom 400;
(way["leisure"="park"](around:{r},{lat},{lon});way["landuse"~"^(forest|grass|recreation_ground|village_green)$"](around:{r},{lat},{lon});way["natural"="wood"](around:{r},{lat},{lon}););
out center 600;"""


def fetch_sites(lat: float, lon: float) -> dict:
    q = sites_query(lat, lon)
    last = None
    for url in C.OVERPASS_URLS:
        try:
            r = SESSION.post(url, data={"data": q}, timeout=60)
            r.raise_for_status()
            return parse_sites(r.json().get("elements", []), lat, lon)
        except Exception as e:  # noqa: BLE001
            last = e
            log.warning("Overpass %s failed: %s", url, e)
    raise RuntimeError(f"Overpass unavailable: {last}")


M_PER_DEG = 111_320.0


def _xy(lat, lon, lat0, lon0):
    return ((lon - lon0) * M_PER_DEG * math.cos(math.radians(lat0)), (lat - lat0) * M_PER_DEG)


def _seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def parse_sites(elements: list[dict], lat0: float, lon0: float) -> dict:
    sites, roads, green = [], [], []
    for e in elements:
        tg = e.get("tags") or {}
        if e.get("type") == "way" and tg.get("highway") and e.get("geometry"):
            roads.append({"name": tg.get("name") or tg.get("ref") or tg["highway"],
                          "pts": [_xy(g["lat"], g["lon"], lat0, lon0) for g in e["geometry"]]})
        elif tg.get("amenity") in C.SITE:
            c = e.get("center") or {"lat": e.get("lat"), "lon": e.get("lon")}
            if c.get("lat") is None:
                continue
            kind = tg["amenity"]
            people, src = C.SITE[kind]["people"], "estimate"
            try:
                cap = int(tg.get("capacity") or tg.get("capacity:pupils") or 0)
            except ValueError:
                cap = 0
            try:
                beds = int(tg.get("beds") or 0)
            except ValueError:
                beds = 0
            if 0 < cap < 20000:
                people, src = cap, "OpenStreetMap capacity"
            elif kind == "hospital" and 0 < beds < 5000:
                people, src = beds * 2, "beds x 2"
            sites.append({"id": f"{e['type'][0]}{e['id']}", "type": kind,
                          "name": tg.get("name") or tg.get("name:en") or f"Unnamed {C.SITE[kind]['label'].lower()}",
                          "lat": c["lat"], "lon": c["lon"], "xy": _xy(c["lat"], c["lon"], lat0, lon0),
                          "people": people, "people_source": src})
        elif e.get("center") and (tg.get("leisure") or tg.get("landuse") or tg.get("natural")):
            green.append(_xy(e["center"]["lat"], e["center"]["lon"], lat0, lon0))
    for s in sites:
        best, name = math.inf, None
        for r in roads:
            for a, b in zip(r["pts"], r["pts"][1:]):
                d = _seg_dist(s["xy"], a, b)
                if d < best:
                    best, name = d, r["name"]
        s["road_dist_m"] = None if best == math.inf else round(best)
        s["road"] = name
        s["green_within_300m"] = sum(1 for g in green if math.hypot(g[0] - s["xy"][0], g[1] - s["xy"][1]) <= 300)
        del s["xy"]
    return {"sites": sites, "major_roads": len(roads), "green_spaces": len(green)}
