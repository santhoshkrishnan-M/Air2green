"""Storage: OpenSearch when OPENSEARCH_URL is set, otherwise a local JSON file
(same methods). Holds hourly world snapshots and alert events."""
from __future__ import annotations

import json
import logging
import os

from . import config as C

log = logging.getLogger("air2green.store")

SNAPSHOT_MAPPING = {"mappings": {"properties": {
    "taken_at": {"type": "date"}, "cc": {"type": "keyword"}, "country": {"type": "keyword"},
    "name": {"type": "keyword"}, "location": {"type": "geo_point"},
    "pm25": {"type": "float"}, "peak24": {"type": "float"}}}}
EVENTS_MAPPING = {"mappings": {"properties": {
    "event_id": {"type": "keyword"}, "city": {"type": "keyword"}, "cc": {"type": "keyword"},
    "location": {"type": "geo_point"}, "status": {"type": "keyword"}, "start": {"type": "keyword"},
    "peak_pm25": {"type": "float"}, "detected_at": {"type": "date"}, "alerted": {"type": "boolean"},
    "person_hours_moved_indoors": {"type": "integer"}}}}


class OpenSearchStore:
    kind = "opensearch"

    def __init__(self, url):
        from opensearchpy import OpenSearch, helpers
        auth = (C.OPENSEARCH_USER, C.OPENSEARCH_PASSWORD) if C.OPENSEARCH_USER else None
        self.c = OpenSearch(hosts=[url], http_auth=auth, use_ssl=url.startswith("https"),
                            verify_certs=url.startswith("https"), timeout=30)
        self.helpers = helpers
        self.c.info()
        for idx, m in ((C.SNAPSHOT_INDEX, SNAPSHOT_MAPPING), (C.EVENTS_INDEX, EVENTS_MAPPING)):
            if not self.c.indices.exists(index=idx):
                self.c.indices.create(index=idx, body=m)

    def save_snapshot(self, rows, taken_at):
        docs = ({"_index": C.SNAPSHOT_INDEX, "_id": f"{r['cc']}-{taken_at[:13]}",
                 "_source": {**r, "taken_at": taken_at, "location": {"lat": r["lat"], "lon": r["lon"]}}} for r in rows)
        self.helpers.bulk(self.c, docs)
        self.c.indices.refresh(index=C.SNAPSHOT_INDEX)

    def latest_snapshot(self):
        r = self.c.search(index=C.SNAPSHOT_INDEX, body={"size": 1, "sort": [{"taken_at": "desc"}]})
        hits = r["hits"]["hits"]
        if not hits:
            return []
        t = hits[0]["_source"]["taken_at"]
        r = self.c.search(index=C.SNAPSHOT_INDEX, body={"size": 500, "query": {"term": {"taken_at": t}}})
        return [h["_source"] for h in r["hits"]["hits"]]

    def get_event(self, event_id):
        r = self.c.get(index=C.EVENTS_INDEX, id=event_id, ignore=404)
        return r.get("_source") if r.get("found") else None

    def save_event(self, ev):
        self.c.index(index=C.EVENTS_INDEX, id=ev["event_id"], body=ev, refresh=True)

    def events(self, city=None, status=None, limit=100):
        f = [{"term": {k: v}} for k, v in (("city", city), ("status", status)) if v]
        r = self.c.search(index=C.EVENTS_INDEX, body={"size": limit, "query": {"bool": {"filter": f}},
                                                      "sort": [{"detected_at": "desc"}]})
        return [h["_source"] for h in r["hits"]["hits"]]


class LocalStore:
    kind = "local-json"

    def __init__(self, path=None):
        self.path = os.path.abspath(path or C.LOCAL_STORE)
        self.data = {"snapshot": [], "events": {}}
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.data.update(json.load(f))

    def _flush(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w") as f:
            json.dump(self.data, f)

    def save_snapshot(self, rows, taken_at):
        self.data["snapshot"] = [{**r, "taken_at": taken_at} for r in rows]
        self._flush()

    def latest_snapshot(self):
        return self.data["snapshot"]

    def get_event(self, event_id):
        return self.data["events"].get(event_id)

    def save_event(self, ev):
        self.data["events"][ev["event_id"]] = ev
        self._flush()

    def events(self, city=None, status=None, limit=100):
        ev = [e for e in self.data["events"].values() if (not city or e["city"] == city) and (not status or e["status"] == status)]
        return sorted(ev, key=lambda e: e["detected_at"], reverse=True)[:limit]


def get_store():
    if C.OPENSEARCH_URL:
        try:
            return OpenSearchStore(C.OPENSEARCH_URL)
        except Exception as e:  # noqa: BLE001
            log.warning("OpenSearch unreachable (%s); using local JSON store", e)
    return LocalStore()
