"""Long-term fix: rank schools and hospitals by Green Gap and write a planting plan for each.

Green Gap = pollution (24 h excess over WHO) x traffic exposure (distance to a major road)
            x missing greenery (parks/woods within 300 m) x people
Placement rules follow Abhijith et al. 2017 (Atmospheric Environment): continuous dense
barriers along open roads; avoid tall closed canopies over narrow built-up streets."""
from __future__ import annotations

from . import config as C

INDIA_SPECIES = ["Neem (Azadirachta indica)", "Pongam (Millettia pinnata)", "Mast tree (Polyalthia longifolia)",
                 "Arjun (Terminalia arjuna)", "Jamun (Syzygium cumini)", "Ixora (hedge)", "Bougainvillea (hedge, walls)"]
GENERIC_SPECIES = ("Choose native species: dense evergreen shrubs for hedges, and medium evergreen trees with small, "
                   "rough or hairy leaves, which catch more particles. Ask the local forestry or parks department.")


def tree_equivalent(mean24_pm25: float, mixing_height_m: float | None, area_m2: float = C.BLOCK_M2,
                    removal_g_per_tree_yr: float = C.TREE_G_PER_YR, target: float = C.WHO_24H) -> dict:
    h = mixing_height_m if mixing_height_m else C.DEFAULT_MIXING_HEIGHT_M
    h = max(100.0, min(3000.0, h))
    excess = max(0.0, (mean24_pm25 or 0) - target)
    mass_g = excess * area_m2 * h * 1e-6
    return {"excess_ug_m3": round(excess, 1), "mixing_height_m": round(h), "mixing_height_live": bool(mixing_height_m),
            "excess_mass_g": round(mass_g, 1), "tree_equivalent": round(mass_g / removal_g_per_tree_yr),
            "trees_that_fit": int(area_m2 * C.PLANTABLE_FRACTION / C.TREE_CANOPY_M2),
            "formula": "(excess ug/m3 x area m2 x mixing height m x 1e-6) / g removed per tree per year",
            "removal_g_per_tree_yr": removal_g_per_tree_yr}


def green_gap(site: dict, mean24: float) -> float:
    excess = max(0.0, (mean24 or 0) - C.WHO_24H)
    pol = min(1.0, excess / 85)
    d = site.get("road_dist_m")
    road = 1.0 if d is not None and d <= 60 else 0.6 if d is not None and d <= 200 else 0.3
    green_lack = 1 - min(1.0, site.get("green_within_300m", 0) / 3)
    ppl = 0.3 + 0.7 * min(1.0, site["people"] / 1000)
    return round(pol * road * green_lack * ppl, 3)


def plan_site(site: dict, cc: str) -> dict:
    d = site.get("road_dist_m")
    label = C.SITE[site["type"]]["label"].lower()
    if d is not None and d <= 60:
        layout = [f"Continuous dense hedge (1.5-2 m) between {site.get('road') or 'the road'} and the {label}, no gaps.",
                  "Second row of medium evergreen trees behind it, 5-6 m apart.",
                  "Make the barrier longer than the building so polluted air can't wrap around the ends."]
        avoid = "Gappy single rows of trees, and tall closed canopies over narrow built-up streets: both can trap exhaust."
    elif d is not None and d <= 200:
        layout = ["Hedge along the boundary facing the nearest busy road.", "Shade trees in the grounds and along the entrance path."]
        avoid = "Trees that block ventilation of narrow lanes."
    else:
        layout = ["Shade trees in open ground and along entrance paths.", "Hedges along boundaries facing streets with traffic."]
        avoid = "Planting under overhead lines or close to foundations."
    return {"layout": layout, "avoid": avoid, "species": INDIA_SPECIES if cc == "IN" else GENERIC_SPECIES}


def rank_sites(sites: list[dict], mean24: float, mixing_height: float | None, cc: str, limit: int = 5) -> list[dict]:
    te = tree_equivalent(mean24, mixing_height)
    ranked = sorted(sites, key=lambda s: -green_gap(s, mean24))[:limit]
    return [{**s, "green_gap": green_gap(s, mean24), "plan": plan_site(s, cc),
             "trees_recommended": min(te["tree_equivalent"], te["trees_that_fit"]), "tree_equivalent": te} for s in ranked]
