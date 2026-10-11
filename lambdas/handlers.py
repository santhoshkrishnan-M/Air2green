"""Lambda handlers (packaged by SAM CLI). All data is live.

- monitor_handler : EventBridge, every hour. Saves a world snapshot (every capital) to
                    OpenSearch, analyses the alert cities, sends SNS alerts and all-clears.
- api_handler     : API Gateway. /world, /city, /events, /plan (Strands agent).
"""
import json

from aws_lambda_powertools import Logger, Tracer

from air2green import places, service
from air2green.store import get_store

logger = Logger(service="air2green")
tracer = Tracer(service="air2green")


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def monitor_handler(event, context):
    out = service.monitor()
    logger.info("monitor run", extra=out)
    return out


def _resp(code, body):
    return {"statusCode": code, "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps(body, default=str)}


def _city(qs):
    if qs.get("lat") and qs.get("lon"):
        lat, lon = float(qs["lat"]), float(qs["lon"])
        return {"name": qs.get("name", f"{lat:.3f},{lon:.3f}"), "lat": lat, "lon": lon,
                "cc": (qs.get("cc") or "").upper(), "country": qs.get("country", "")}
    return places.find_city(qs.get("name", ""), qs.get("country") or qs.get("cc"))


@logger.inject_lambda_context
@tracer.capture_lambda_handler
def api_handler(event, context):
    path = event.get("resource") or event.get("path", "")
    qs = event.get("queryStringParameters") or {}
    try:
        if path == "/world":
            rows = get_store().latest_snapshot()
            if not rows:
                rows = service.world_report()["rows"]
            return _resp(200, rows)
        if path == "/city":
            c = _city(qs)
            if not c:
                return _resp(404, {"error": "city not found; pass name (+country) or lat & lon"})
            return _resp(200, service.city_report(c, with_sites=qs.get("sites", "1") == "1"))
        if path == "/events":
            return _resp(200, get_store().events(city=qs.get("city"), status=qs.get("status")))
        if path == "/plan":
            c = _city(qs)
            if not c:
                return _resp(404, {"error": "city not found"})
            from agent.agent import ask
            return _resp(200, {"city": c, "plan": ask(f"Give the bad-air response and planting plan for {c['name']}, {c['country']}.")})
    except Exception as e:  # noqa: BLE001
        logger.exception("request failed")
        return _resp(502, {"error": f"live data source failed: {e}"})
    return _resp(404, {"error": f"unknown route {path}"})
