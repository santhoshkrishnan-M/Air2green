"""High-level operations shared by the Lambdas, the agent and the CLI. All live data."""
from __future__ import annotations

import datetime as dt
import logging

from . import config as C
from . import live, places, planting, response
from .store import get_store

log = logging.getLogger("air2green.service")


def city_report(city: dict, with_sites: bool = True) -> dict:
    """Detect/Explain/Act/Measure + planting for one city, from live data."""
    series = live.city_series(city["lat"], city["lon"])
    sites, sites_error = None, None
    if with_sites:
        try:
            sites = live.fetch_sites(city["lat"], city["lon"])["sites"]
        except Exception as e:  # noqa: BLE001
            sites_error = str(e)
    a = response.analyse(series, city["cc"], sites)
    a["city"] = city
    if sites is not None:
        a["planting"] = planting.rank_sites(sites, a["mean24_pm25"], a["mean24_mixing_height_m"], city["cc"])
    if sites_error:
        a["sites_error"] = sites_error
    return a


def world_report() -> dict:
    caps = places.capitals()
    rows = live.world_snapshot(caps)
    taken = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for r in rows:
        sc = response.scale_for("US")  # one scale for comparison across countries
        b = response.band(r["pm25"], sc)
        r["band_us_epa"] = b["name"] if b else None
    return {"taken_at": taken, "rows": rows}


def event_id(city: dict, a: dict) -> str:
    return f"EV-{city['cc']}-{city['name'].replace(' ', '')}-{a['event']['start'].replace('-', '').replace(':', '').replace('T', '')}"


def monitor() -> dict:
    """Hourly job: store a world snapshot; analyse alert cities; alert on new events, all-clear on ended ones."""
    store = get_store()
    out = {"snapshot": 0, "alerts_sent": [], "cleared": [], "errors": []}
    try:
        w = world_report()
        store.save_snapshot(w["rows"], w["taken_at"])
        out["snapshot"] = len(w["rows"])
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"world: {e}")
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for city in places.parse_city_list(C.ALERT_CITIES):
        try:
            a = city_report(city)
        except Exception as e:  # noqa: BLE001
            out["errors"].append(f"{city['name']}: {e}")
            continue
        open_events = [e for e in store.events(city=city["name"], status="open") if e["cc"] == city["cc"]]
        if a["event"]:
            eid = event_id(city, a)
            if not store.get_event(eid):
                ev = {"event_id": eid, "city": city["name"], "cc": city["cc"], "location": {"lat": city["lat"], "lon": city["lon"]},
                      "status": "open", "start": a["event"]["start"], "end_forecast": a["event"]["end"],
                      "peak_pm25": a["event"]["peak_pm25"], "peak_band": a["event"]["peak_band"],
                      "cause": a["likely_cause"]["cause"], "detected_at": now,
                      "person_hours_moved_indoors": (a.get("measure") or {}).get("person_hours_moved_indoors", 0)}
                publish(f"AIR2GREEN alert: {city['name']} PM2.5 {a['event']['peak_band']}", response.alert_text(city, a))
                ev["alerted"] = True
                store.save_event(ev)
                out["alerts_sent"].append(eid)
            open_events = [e for e in open_events if e["event_id"] != eid]
        for e in open_events:   # an open event whose alert window is gone -> all clear
            if a["status"] == "no_alert_48h" or (a["event"] and event_id(city, a) != e["event_id"]):
                e["status"], e["cleared_at"] = "cleared", now
                store.save_event(e)
                publish(f"AIR2GREEN all clear: {city['name']}",
                        f"The air in {city['name']} is back below {a['alert_above']} ug/m3 ({a['scale']}). "
                        f"PM2.5 now {a['current']['pm25']}. Event {e['event_id']} closed. "
                        f"Estimated exposure avoided if schools and hospitals acted: ~{e.get('person_hours_moved_indoors', 0)} person-hours indoors.")
                out["cleared"].append(e["event_id"])
    return out


def publish(subject: str, message: str):
    if not C.SNS_TOPIC_ARN:
        log.info("SNS not configured; alert would be: %s", subject)
        return
    import boto3
    boto3.client("sns").publish(TopicArn=C.SNS_TOPIC_ARN, Subject=subject[:99], Message=message)


if __name__ == "__main__":
    import json
    import sys
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) > 1 and sys.argv[1] == "monitor":
        print(json.dumps(monitor(), indent=2))
    else:
        name = sys.argv[1] if len(sys.argv) > 1 else "Chennai"
        cc = sys.argv[2] if len(sys.argv) > 2 else None
        c = places.find_city(name, cc)
        if not c:
            sys.exit(f"City not found: {name}")
        rep = city_report(c)
        print(response.alert_text(c, rep))
