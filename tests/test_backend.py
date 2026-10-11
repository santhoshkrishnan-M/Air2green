"""Backend tests. HTTP is replaced by synthetic Open-Meteo/Overpass-shaped responses
(tests/fakeapi.py); the code under test is the same code that runs against live APIs.
Run: python -m pytest -q"""
import os
import sys
from urllib.parse import parse_qs

import pytest

sys.path.insert(0, os.path.dirname(__file__))
from fakeapi import aq_response, overpass_response, wx_response  # noqa: E402

from air2green import config as C  # noqa: E402
from air2green import live, places, planting, response, service  # noqa: E402


@pytest.fixture
def fake_http(monkeypatch, tmp_path):
    def fake_get(url, params):
        q = {k: [str(v)] for k, v in params.items()}
        return aq_response(q) if "air-quality" in url else wx_response(q)

    class R:
        def __init__(self, j): self._j = j
        def raise_for_status(self): pass
        def json(self): return self._j

    def fake_post(url, data, timeout):
        import re
        m = re.search(r"around:\d+,([-\d.]+),([-\d.]+)", data["data"])
        return R(overpass_response(float(m.group(1)), float(m.group(2))))

    monkeypatch.setattr(live, "_get", fake_get)
    monkeypatch.setattr(live.SESSION, "post", fake_post)
    monkeypatch.setattr(C, "LOCAL_STORE", str(tmp_path / "store.json"))
    monkeypatch.setattr(C, "OPENSEARCH_URL", "")
    sent = []
    monkeypatch.setattr(service, "publish", lambda s, m: sent.append((s, m)))
    return sent


def test_places_cover_the_world():
    ps = places.countries()
    assert len(ps) > 240
    assert places.find_city("Chennai", "IN")["cc"] == "IN"
    assert places.find_country("india")["c"] == "IN"
    assert all(p["cap"][0] for p in ps)


def test_scales_and_alert_levels():
    assert response.alert_level(C.SCALES["cpcb"]) == 90
    assert response.alert_level(C.SCALES["epa"]) == 35.4
    assert response.band(95, C.SCALES["cpcb"])["name"] == "Poor"
    assert response.band(40, C.SCALES["epa"])["name"] == "Unhealthy for sensitive groups"
    assert response.scale_for("IN")["name"].startswith("India")
    assert response.scale_for("FR")["name"].startswith("US EPA")


def test_events_open_and_close():
    pm = [10, 10, 100, 120, 100, 10, 10, 10]
    ev = response.detect_events(pm, 90)
    assert ev == [{"s": 2, "e": 4, "peak": 120, "pi": 3}]
    assert response.detect_events([10, 100, 100], 90)[0]["open"]


def test_likely_cause_rules():
    assert response.likely_cause(pm=80, pm10=200, dust=150)["key"] == "dust"
    assert response.likely_cause(pm=80, wind=1.0)["key"] == "stagnant"
    assert response.likely_cause(pm=80, co=900, wind=4, blh=900, hour=8)["key"] == "traffic"
    assert response.likely_cause(pm=80, co=900, wind=4, blh=900, hour=14)["key"] == "smoke"


def test_exposure_counts_only_open_hours():
    times = [f"2026-10-10T{h:02d}:00" for h in range(24)]
    pm = [100.0] * 24
    x = response.exposure_avoided("school", 600, times, pm, {"s": 8, "e": 10})
    assert x["person_hours_moved_indoors"] == 900 and x["exposure_cut_pct"] == 20.0
    assert response.exposure_avoided("school", 600, times, pm, {"s": 19, "e": 22})["person_hours_moved_indoors"] == 0


def test_tree_equivalent_units():
    t = planting.tree_equivalent(82, 1000)
    assert t["excess_mass_g"] == 4187.5 and t["tree_equivalent"] == 335 and t["trees_that_fit"] == 62


def test_parse_sites_distance_to_road():
    els = [{"type": "node", "id": 1, "lat": 13.0, "lon": 80.0, "tags": {"amenity": "school", "name": "A"}},
           {"type": "way", "id": 2, "tags": {"highway": "primary", "name": "Main"},
            "geometry": [{"lat": 13.0003, "lon": 79.99}, {"lat": 13.0003, "lon": 80.01}]}]
    s = live.parse_sites(els, 13.0, 80.0)["sites"][0]
    assert 30 <= s["road_dist_m"] <= 36 and s["road"] == "Main"


def test_city_report_end_to_end(fake_http):
    c = places.find_city("Agra", "IN")
    rep = service.city_report(c)
    assert rep["scale"].startswith("India") and rep["current"]["pm25"] > 0
    assert rep["status"] in ("alert_now", "alert_coming", "no_alert_48h")
    assert rep["exposed_sites"] and rep["planting"]
    assert "Schools:" in response.alert_text(c, rep)


def test_world_report(fake_http):
    w = service.world_report()
    assert len(w["rows"]) > 240 and all("band_us_epa" in r for r in w["rows"])


def test_monitor_alerts_once(fake_http, monkeypatch):
    monkeypatch.setattr(C, "ALERT_CITIES", "Agra,IN")
    first = service.monitor()
    second = service.monitor()
    assert first["snapshot"] > 240
    assert len(first["alerts_sent"]) == 1 and second["alerts_sent"] == []
    assert len(fake_http) == 1
