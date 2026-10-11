"""Synthetic responses shaped like Open-Meteo and Overpass. TEST USE ONLY:
the app and backend never ship or fall back to this data."""
import math
from datetime import datetime, timedelta

NOW = datetime(2026, 10, 10, 9, 0)


def series(lat, lon, n, start, kind="pm"):
    base = 8 + 70 * math.exp(-((lat - 27) ** 2 + (lon - 78) ** 2) / 200) + 25 * math.exp(-((lat - 33) ** 2 + (lon - 115) ** 2) / 300)
    out = []
    for i in range(n):
        h = (start + timedelta(hours=i)).hour
        day = (start + timedelta(hours=i)).day
        spike = 70 * math.exp(-((h - 8) ** 2) / 4) if day == 11 else 0
        v = base * (0.75 + 0.35 * math.exp(-((h - 8) ** 2) / 6) + 0.4 * math.exp(-((h - 21) ** 2) / 8)) + spike
        out.append(round(v, 1) if kind == "pm" else round(v * 1.6, 1) if kind == "pm10" else round(v * 0.15, 1) if kind == "dust" else round(300 + v * 6, 0))
    return out


def aq_response(q):
    lats = [float(x) for x in q["latitude"][0].split(",")]
    lons = [float(x) for x in q["longitude"][0].split(",")]
    past = int(q.get("past_days", ["0"])[0]); fdays = int(q.get("forecast_days", ["0"])[0] or 0)
    fh = int(q.get("forecast_hours", ["0"])[0] or 0)
    if fh:
        start, n = NOW, fh
    else:
        start = NOW.replace(hour=0) - timedelta(days=past); n = 24 * (past + fdays)
    hourly_vars = q.get("hourly", [""])[0].split(",")
    res = []
    for la, lo in zip(lats, lons):
        times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(n)]
        hourly = {"time": times}
        for v in hourly_vars:
            hourly[v] = series(la, lo, n, start, {"pm2_5": "pm", "pm10": "pm10", "dust": "dust"}.get(v, "co"))
        cur = {"time": NOW.strftime("%Y-%m-%dT%H:%M"), "interval": 3600}
        for v in q.get("current", [""])[0].split(","):
            if v:
                cur[v] = series(la, lo, 1, NOW, {"pm2_5": "pm", "pm10": "pm10", "dust": "dust"}.get(v, "co"))[0]
        res.append({"latitude": la, "longitude": lo, "utc_offset_seconds": 19800, "timezone": "Asia/Kolkata",
                    "current": cur, "hourly": hourly})
    return res[0] if len(res) == 1 else res


def wx_response(q):
    past = int(q["past_days"][0]); fdays = int(q["forecast_days"][0])
    start = NOW.replace(hour=0) - timedelta(days=past); n = 24 * (past + fdays)
    times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(n)]
    return {"hourly": {"time": times,
                       "wind_speed_10m": [round(1.2 + 3 * abs(math.sin(i / 7)), 1) for i in range(n)],
                       "wind_direction_10m": [200] * n,
                       "boundary_layer_height": [round(180 + 900 * max(0, math.sin((((start + timedelta(hours=i)).hour) - 6) / 12 * math.pi)), 0) for i in range(n)]}}


def overpass_response(lat, lon):
    els = []
    names = ["Govt. Higher Secondary School", "St. Joseph's School", "City College", "General Hospital", "Kids Kindergarten", "Health Clinic"]
    types = ["school", "school", "college", "hospital", "kindergarten", "clinic"]
    for i in range(18):
        a = i * 0.9
        d = 0.002 + 0.0009 * i
        els.append({"type": "node", "id": 100 + i, "lat": lat + d * math.sin(a), "lon": lon + d * math.cos(a),
                    "tags": {"amenity": types[i % 6], "name": f"{names[i % 6]} {i}"}})
    els.append({"type": "way", "id": 9, "tags": {"highway": "primary", "name": "Main Road"},
                "geometry": [{"lat": lat - 0.02, "lon": lon + k * 0.002 - 0.02} for k in range(21)]})
    for i in range(5):
        els.append({"type": "way", "id": 50 + i, "center": {"lat": lat + 0.008 * i, "lon": lon - 0.006}, "tags": {"leisure": "park"}})
    return {"elements": els}


