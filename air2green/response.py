"""Bad-air response on a live hourly series: Detect -> Explain -> Act -> Measure.
Mirrors analyseCity() in web/app.js so the app, the alerts and the agent agree."""
from __future__ import annotations

from . import config as C

ROAD_NEAR_M = 60


def scale_for(cc: str) -> dict:
    if C.SCALE_OVERRIDE in C.SCALES:
        return C.SCALES[C.SCALE_OVERRIDE]
    return C.SCALES["cpcb"] if cc == "IN" else C.SCALES["epa"]


def band(v, scale) -> dict | None:
    if v is None:
        return None
    for mx, name, lvl in scale["bands"]:
        if v <= mx:
            return {"name": name, "lvl": lvl, "max": mx}
    mx, name, lvl = scale["bands"][-1]
    return {"name": name, "lvl": lvl, "max": mx}


def alert_level(scale) -> float:
    """PM2.5 above this value triggers an alert (start of the first level-2 band)."""
    bands = scale["bands"]
    i = next(i for i, b in enumerate(bands) if b[2] >= 2)
    return bands[i - 1][0]


def hour_of(ts: str) -> int:
    return int(ts[11:13])


def detect_events(pm: list, thr: float, clear_hours: int = C.CLEAR_HOURS) -> list[dict]:
    events, cur, quiet = [], None, 0
    for i, v in enumerate(pm):
        if v is not None and v > thr:
            if cur is None:
                cur = {"s": i, "e": i, "peak": v, "pi": i}
            cur["e"] = i
            if v > cur["peak"]:
                cur["peak"], cur["pi"] = v, i
            quiet = 0
        elif cur is not None:
            quiet += 1
            if quiet >= clear_hours:
                events.append(cur)
                cur, quiet = None, 0
    if cur is not None:
        cur["open"] = True
        events.append(cur)
    return events


def likely_cause(pm=None, pm10=None, dust=None, co=None, wind=None, blh=None, hour=12) -> dict:
    sig = {"pm25": pm, "pm10": pm10, "dust": dust, "co": co, "wind_ms": wind, "mixing_height_m": blh, "hour": hour}
    if dust is not None and pm10 and dust >= 0.5 * pm10 and pm10 > 50:
        return {"key": "dust", "cause": "Desert or wind-blown dust", "signals": sig,
                "why": f"Dust makes up about {round(dust / pm10 * 100)}% of PM10 in the model.",
                "source_action": "Little can be controlled locally: warn the public early, damp down construction and road dust."}
    if (wind is not None and wind < 2) or (blh is not None and blh < 300):
        return {"key": "stagnant", "cause": "Still air trapping local pollution", "signals": sig,
                "why": "Weak wind and/or a shallow mixing layer keep traffic, cooking and burning smoke near the ground.",
                "source_action": "Pause open burning and dusty construction until the air mixes again; ease traffic near schools and hospitals."}
    if co is not None and co > 500 and hour in (7, 8, 9, 10, 17, 18, 19, 20, 21):
        return {"key": "traffic", "cause": "Traffic and fuel burning at rush hour", "signals": sig,
                "why": f"Carbon monoxide is raised ({round(co)} ug/m3) at a peak traffic hour.",
                "source_action": "Keep traffic moving near schools; stop buses and trucks idling; check for waste burning."}
    if co is not None and co > 500:
        return {"key": "smoke", "cause": "Smoke from burning (fires, waste or crop burning)", "signals": sig,
                "why": f"Carbon monoxide is raised ({round(co)} ug/m3) outside rush hour.",
                "source_action": "Ask the municipality to find and stop waste, crop or biomass burning in and around the city."}
    return {"key": "regional", "cause": "Regional haze carried in from elsewhere", "signals": sig,
            "why": "No strong local signal (dust, still air or combustion) at this hour.",
            "source_action": "Local action has limited effect today; protect people and report the episode to the regional pollution board."}


def actions_for(lvl: int, cause: dict) -> dict:
    if lvl >= 4:
        school = ["Consider closing or moving to online classes.", "Keep all children indoors with windows closed."]
    elif lvl >= 3:
        school = ["Cancel outdoor PE, sports and assembly.", "Keep children indoors at break times.",
                  "Close road-facing windows during peak hours.", "Shift dismissal away from the peak hour; N95 masks for walking home."]
    elif lvl >= 2:
        school = ["Move PE, sports and assembly indoors.", "Close road-facing windows during peak hours.",
                  "Let children with asthma skip strenuous activity."]
    elif lvl >= 1:
        school = ["Let children with asthma or allergies skip strenuous outdoor PE."]
    else:
        school = ["No changes needed."]
    health = (["Keep windows closed; air purifiers in wards with lung or heart patients.", "Move outpatient queues indoors."]
              if lvl >= 2 else ["Remind patients with lung or heart conditions to limit time outdoors."] if lvl >= 1 else ["No changes needed."])
    people = (["Stay indoors; N95 mask if you must go out."] if lvl >= 4 else
              ["Avoid outdoor exercise; N95 mask outdoors."] if lvl >= 3 else
              ["Cut long or heavy outdoor exercise; sensitive groups stay indoors at peak hours."] if lvl >= 2 else
              ["Sensitive groups: take it easier outdoors."] if lvl >= 1 else ["Enjoy being outside."])
    return {"schools": school, "health": health, "everyone": people,
            "city": [cause["source_action"]] if lvl >= 1 else ["No source action needed today."]}


def exposure_avoided(site_type: str, people: int, times: list[str], pm: list, ev: dict,
                     io_ratio: float = C.INDOOR_OUTDOOR_RATIO) -> dict:
    prof = C.SITE.get(site_type)
    if not prof or not ev:
        return {"person_hours_moved_indoors": 0, "exposure_cut_pct": 0.0, "hours_present": 0}
    h0, h1 = prof["hours"]
    hours = [i for i in range(ev["s"], ev["e"] + 1) if h0 <= hour_of(times[i]) < h1 and pm[i] is not None]
    if not hours:
        return {"person_hours_moved_indoors": 0, "exposure_cut_pct": 0.0, "hours_present": 0,
                "note": f"No {prof['who']} on site during the alert hours."}
    shifted = min(prof["shift"], len(hours))
    avg = sum(pm[i] for i in hours) / len(hours)
    before = len(hours) * avg
    after = before - shifted * avg * (1 - io_ratio)
    return {"person_hours_moved_indoors": round(people * shifted), "hours_present": len(hours),
            "exposure_cut_pct": round((before - after) / before * 100, 1) if before else 0.0,
            "avg_outdoor_pm25": round(avg, 1), "assumptions": {"indoor_outdoor_ratio": io_ratio, "outdoor_hours_moved": shifted,
                                                               "site_hours_local": [h0, h1]}}


def analyse(series: dict, cc: str, sites: list[dict] | None = None) -> dict:
    """Full analysis for one city from live_series(). Times are local to the city."""
    T, pm, now = series["time"], series["pm25"], series["now"]
    scale = scale_for(cc)
    thr = alert_level(scale)
    events = detect_events(pm, thr)
    active = next((e for e in events if e["s"] <= now <= e["e"] + 1), None)
    upcoming = next((e for e in events if now < e["s"] <= now + 48), None)
    focus = active or upcoming
    fi = focus["pi"] if focus else now
    g = lambda k: (series.get(k) or [None] * len(T))[fi]  # noqa: E731
    cause = likely_cause(pm[fi], g("pm10"), g("dust"), g("co"), g("wind"), g("blh"), hour_of(T[fi]))
    cur = series.get("current") if series.get("current") is not None else pm[now]
    cur_band = band(cur, scale)
    lvl = band(focus["peak"], scale)["lvl"] if focus else cur_band["lvl"]
    past = [v for v in pm[max(0, now - 23):now + 1] if v is not None]
    blh_past = [v for v in (series.get("blh") or [])[max(0, now - 23):now + 1] if v is not None]
    best = None
    for i in range(now, min(len(T) - 1, now + 36)):
        if 6 <= hour_of(T[i]) <= 18 and pm[i] is not None and pm[i + 1] is not None:
            v = (pm[i] + pm[i + 1]) / 2
            if best is None or v < best["pm25"]:
                best = {"from": T[i], "pm25": round(v, 1)}
    out = {
        "scale": scale["name"], "alert_above": thr, "now_local": T[now],
        "current": {"pm25": cur, "band": cur_band["name"], "times_who": round(cur / C.WHO_24H, 1) if cur else None},
        "status": "alert_now" if active else "alert_coming" if upcoming else "no_alert_48h",
        "event": None if not focus else {"start": T[focus["s"]], "end": T[focus["e"]], "open_ended": bool(focus.get("open")),
                                         "peak_pm25": round(focus["peak"], 1), "peak_time": T[focus["pi"]],
                                         "peak_band": band(focus["peak"], scale)["name"]},
        "likely_cause": cause, "actions": actions_for(lvl, cause), "best_outdoor_window": best,
        "mean24_pm25": round(sum(past) / len(past), 1) if past else None,
        "mean24_mixing_height_m": round(sum(blh_past) / len(blh_past)) if blh_past else None,
    }
    if sites is not None:
        per = []
        for s in sites:
            x = exposure_avoided(s["type"], s["people"], T, pm, focus) if focus else {"person_hours_moved_indoors": 0, "exposure_cut_pct": 0.0}
            per.append({**s, "exposure": x})
        measured = [p for p in per if p["exposure"]["person_hours_moved_indoors"]]
        out["exposed_sites"] = sorted(per, key=lambda p: (-p["exposure"]["person_hours_moved_indoors"], p.get("road_dist_m") or 1e9))
        out["measure"] = {"sites_open_during_alert": len(measured),
                          "person_hours_moved_indoors": sum(p["exposure"]["person_hours_moved_indoors"] for p in measured),
                          "avg_exposure_cut_pct": round(sum(p["exposure"]["exposure_cut_pct"] for p in measured) / len(measured), 1) if measured else 0.0}
    return out


def alert_text(city: dict, a: dict) -> str:
    ev = a["event"]
    lines = [f"AIR2GREEN alert: {city['name']}, {city['country']}",
             f"PM2.5 now {a['current']['pm25']} ug/m3 ({a['current']['band']}, {a['scale']})."]
    if ev:
        lines.append(f"{'Alert now' if a['status'] == 'alert_now' else 'Alert coming'}: above {a['alert_above']} ug/m3 from "
                     f"{ev['start'].replace('T', ' ')} to {ev['end'].replace('T', ' ')} (local), peak {ev['peak_pm25']} ({ev['peak_band']}).")
    lines += [f"Likely cause: {a['likely_cause']['cause']}.", "", "Schools:"] + [f"  - {x}" for x in a["actions"]["schools"]]
    lines += ["Hospitals:"] + [f"  - {x}" for x in a["actions"]["health"]]
    lines += ["City officials:"] + [f"  - {x}" for x in a["actions"]["city"]]
    m = a.get("measure")
    if m and m["person_hours_moved_indoors"]:
        lines += ["", f"If {m['sites_open_during_alert']} schools/hospitals act: ~{m['person_hours_moved_indoors']} person-hours moved "
                      f"indoors, ~{m['avg_exposure_cut_pct']}% less PM2.5 breathed during the alert."]
    if a.get("best_outdoor_window"):
        lines.append(f"Best time outdoors: {a['best_outdoor_window']['from'].replace('T', ' ')} for 2 hours.")
    return "\n".join(lines)
