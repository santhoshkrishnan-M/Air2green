"""Countries, capitals and major cities (GeoNames, bundled in data/places.json)."""
import json
import os
from functools import lru_cache


@lru_cache(maxsize=1)
def countries() -> list[dict]:
    with open(os.path.join(os.path.dirname(__file__), "data", "places.json"), encoding="utf-8") as f:
        return json.load(f)


def by_cc(cc: str) -> dict | None:
    cc = cc.upper()
    return next((p for p in countries() if p["c"] == cc), None)


def find_country(q: str) -> dict | None:
    q = q.strip().lower()
    for p in countries():
        if p["c"].lower() == q or p["i3"].lower() == q or p["n"].lower() == q:
            return p
    return next((p for p in countries() if p["n"].lower().startswith(q)), None)


def find_city(name: str, country: str | None = None) -> dict | None:
    """Return {name, lat, lon, cc, country, pop} for the best match, largest city first."""
    name = name.strip().lower()
    pool = [find_country(country)] if country else countries()
    hits = []
    for p in pool:
        if not p:
            continue
        for c in p["cities"]:
            n = c[0].lower()
            if n == name or n.startswith(name):
                hits.append((n != name, -(c[3] or 0), {"name": c[0], "lat": c[1], "lon": c[2], "cc": p["c"],
                                                         "country": p["n"], "pop": c[3]}))
    return sorted(hits, key=lambda h: h[:2])[0][2] if hits else None


def capitals() -> list[dict]:
    return [{"name": p["cap"][0], "lat": p["cap"][1], "lon": p["cap"][2], "cc": p["c"], "country": p["n"]} for p in countries()]


def parse_city_list(spec: str) -> list[dict]:
    out = []
    for part in filter(None, (s.strip() for s in spec.split(";"))):
        name, _, cc = part.partition(",")
        c = find_city(name, cc or None)
        if c:
            out.append(c)
    return out
