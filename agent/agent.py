"""AIR2GREEN agent (Strands Agents SDK). Every tool reads live data, so the agent
never invents a number.

    python -m agent.agent "Is the air in Lahore dangerous today, and what should schools do?"

Model provider (env A2G_MODEL_PROVIDER): bedrock (default, AWS credentials; set A2G_MODEL_ID),
ollama (local; pip install 'strands-agents[ollama]'), anthropic (ANTHROPIC_API_KEY).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from strands import Agent, tool  # noqa: E402

from air2green import live, places, planting, response, service  # noqa: E402
from air2green.store import get_store  # noqa: E402


def _city(city: str, country: str = ""):
    c = places.find_city(city, country or None)
    if not c:
        raise ValueError(f"City '{city}' not found. Use a major city name and optionally the country.")
    return c


@tool
def get_world_air(kind: str = "worst", limit: int = 10) -> list:
    """Live PM2.5 at every country's capital (CAMS model via Open-Meteo), ranked.

    Args:
        kind: "worst" (highest now), "cleanest", or "rising" (forecast to cross the US EPA
              unhealthy-for-sensitive-groups level within 24 h)
        limit: how many countries to return (1-50)
    """
    rows = [r for r in service.world_report()["rows"] if r["pm25"] is not None]
    if kind == "cleanest":
        rows.sort(key=lambda r: r["pm25"])
    elif kind == "rising":
        rows = sorted([r for r in rows if r["pm25"] <= 35.4 < (r["peak24"] or 0)], key=lambda r: -r["peak24"])
    else:
        rows.sort(key=lambda r: -r["pm25"])
    return [{k: r[k] for k in ("country", "name", "pm25", "peak24", "band_us_epa")} for r in rows[:max(1, min(limit, 50))]]


@tool
def get_country_cities(country: str) -> list:
    """Live PM2.5 now and next-24h peak for the major cities of one country.

    Args:
        country: country name or ISO code, e.g. "India" or "IN"
    """
    p = places.find_country(country)
    if not p:
        return [{"error": f"country '{country}' not found"}]
    cities = [{"name": c[0], "lat": c[1], "lon": c[2], "cc": p["c"], "country": p["n"]} for c in p["cities"]]
    rows = live.world_snapshot(cities)
    sc = response.scale_for(p["c"])
    return sorted([{"city": r["name"], "pm25": r["pm25"], "peak24": r["peak24"],
                    "band": (response.band(r["pm25"], sc) or {}).get("name")} for r in rows],
                  key=lambda r: -(r["pm25"] or 0))


@tool
def get_city_air(city: str, country: str = "") -> dict:
    """Live bad-air analysis for one city: current PM2.5 and band, alert now or coming in 48 h,
    likely cause (wind, mixing height, dust, carbon monoxide), actions by audience and the best
    outdoor window. Does not include schools/hospitals (use get_city_sites).

    Args:
        city: city name, e.g. "Chennai"
        country: optional country name or ISO code to disambiguate
    """
    c = _city(city, country)
    a = response.analyse(live.city_series(c["lat"], c["lon"]), c["cc"])
    return {"city": c, **a}


@tool
def get_city_sites(city: str, country: str = "") -> dict:
    """Schools, colleges, hospitals and clinics within 2 km of the city centre (OpenStreetMap),
    with distance to the nearest major road, nearby green spaces, people estimate, and the
    exposure each would avoid during the current or coming alert.

    Args:
        city: city name
        country: optional country name or ISO code
    """
    c = _city(city, country)
    rep = service.city_report(c)
    sites = rep.get("exposed_sites") or []
    return {"city": c, "status": rep["status"], "measure": rep.get("measure"), "sites_error": rep.get("sites_error"),
            "count": len(sites), "top_sites": sites[:15]}


@tool
def get_planting_plan(city: str, country: str = "") -> dict:
    """Long-term fix: the five schools/hospitals where planting protects the most people
    (Green Gap), with layout, what to avoid, species guidance and the tree-equivalent of the
    local PM2.5 burden using live 24-h PM2.5 and live mixing height.

    Args:
        city: city name
        country: optional country name or ISO code
    """
    c = _city(city, country)
    rep = service.city_report(c)
    return {"city": c, "mean24_pm25": rep["mean24_pm25"], "plan": rep.get("planting"), "sites_error": rep.get("sites_error")}


@tool
def calc_tree_equivalent(mean24_pm25: float, mixing_height_m: float = 1000, area_m2: float = 62500,
                         removal_g_per_tree_yr: float = 12.5) -> dict:
    """Tree-equivalent of excess PM2.5 above the WHO 24-h guideline (15 ug/m3) for an area,
    with all assumptions returned.

    Args:
        mean24_pm25: 24-hour mean PM2.5 in ug/m3
        mixing_height_m: boundary-layer height in metres
        area_m2: area in m2 (default one 250 m block)
        removal_g_per_tree_yr: PM2.5 removed by one tree per year in grams
    """
    return planting.tree_equivalent(mean24_pm25, mixing_height_m, area_m2, removal_g_per_tree_yr)


@tool
def get_alert_history(city: str = "", status: str = "") -> list:
    """Alerts recorded by the hourly monitor (OpenSearch), newest first.

    Args:
        city: optional city name filter
        status: "open", "cleared" or empty for both
    """
    return get_store().events(city=city or None, status=status or None, limit=50)


TOOLS = [get_world_air, get_country_cities, get_city_air, get_city_sites, get_planting_plan,
         calc_tree_equivalent, get_alert_history]

SYSTEM_PROMPT = """You are the AIR2GREEN agent. You help schools, hospitals and city officials anywhere in the
world respond to hazardous air today and plan greening for the long term.

Rules:
- Get every number from a tool. Tools return live data; never invent PM2.5, people counts or tree counts.
- Say which scale you use (US EPA AQI, or India CPCB for Indian cities) and that values are CAMS model
  estimates for the area, not a single monitor.
- Times from tools are local to the city.
- The tree-equivalent is an awareness figure; trees cut exposure near them but cutting the source matters most.
- Write for a non-expert: short sections, plain words.

For a city, answer in this order:
1. Detect: is the air dangerous now or in the next 48 hours (band, peak, when)?
2. Explain: likely cause and who is exposed (schools, hospitals near major roads)
3. Act: actions for schools, hospitals, everyone, city officials; best outdoor window
4. Measure: exposure avoided if sites act (with its assumptions)
5. Long term: where to plant and how
"""


def build_model():
    provider = os.getenv("A2G_MODEL_PROVIDER", "bedrock").lower()
    model_id = os.getenv("A2G_MODEL_ID")
    if provider == "ollama":
        from strands.models.ollama import OllamaModel
        return OllamaModel(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"), model_id=model_id or "llama3.1")
    if provider == "anthropic":
        from strands.models.anthropic import AnthropicModel
        return AnthropicModel(client_args={"api_key": os.environ["ANTHROPIC_API_KEY"]}, model_id=model_id, max_tokens=2500)
    from strands.models import BedrockModel
    kw = {"region_name": os.getenv("AWS_REGION", "us-east-1")}
    if model_id:
        kw["model_id"] = model_id
    return BedrockModel(**kw)


def build_agent(callback_handler="default"):
    kw = {} if callback_handler == "default" else {"callback_handler": callback_handler}
    return Agent(model=build_model(), system_prompt=SYSTEM_PROMPT, tools=TOOLS, **kw)


def ask(prompt: str) -> str:
    return str(build_agent(callback_handler=None)(prompt))


if __name__ == "__main__":
    agent = build_agent()
    agent(" ".join(sys.argv[1:]) or "Which countries have the worst air right now, and what should schools in the worst capital do?")
    print()
    for msg in agent.messages:
        for part in msg.get("content", []):
            if "toolUse" in part:
                print(f"[tool] {part['toolUse']['name']}({json.dumps(part['toolUse'].get('input', {}))})")
