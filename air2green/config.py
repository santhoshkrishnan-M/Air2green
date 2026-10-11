"""Every number that affects a result lives here (mirrors CFG/SCALES/SITE in web/app.js)."""
import os

# ---- Live data sources (free, no API key) -----------------------------------
AQ_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"   # CAMS via Open-Meteo
WX_URL = "https://api.open-meteo.com/v1/forecast"                   # wind, boundary-layer height
OVERPASS_URLS = ["https://overpass-api.de/api/interpreter",
                 "https://overpass.kumi.systems/api/interpreter",
                 "https://overpass.private.coffee/api/interpreter"]
BATCH = 80                    # coordinates per Open-Meteo request
SITE_RADIUS_M = 2000          # schools/hospitals searched within this radius of a city centre
HTTP_TIMEOUT = 40

# ---- Air quality scales (PM2.5 ug/m3). lvl: 0 fine, 1 sensitive take care,
# 2 alert (children's outdoor activity indoors), 3 severe, 4 emergency ---------
SCALES = {
    "epa": {"name": "US EPA AQI (2024)", "bands": [
        (9.0, "Good", 0), (35.4, "Moderate", 1), (55.4, "Unhealthy for sensitive groups", 2),
        (125.4, "Unhealthy", 3), (225.4, "Very unhealthy", 4), (1e9, "Hazardous", 4)]},
    "cpcb": {"name": "India CPCB National AQI", "bands": [
        (30, "Good", 0), (60, "Satisfactory", 0), (90, "Moderate", 1),
        (120, "Poor", 2), (250, "Very poor", 3), (1e9, "Severe", 4)]},
}
SCALE_OVERRIDE = os.getenv("A2G_SCALE", "auto")   # auto | epa | cpcb
CLEAR_HOURS = 2
WHO_24H = 15.0

# ---- Exposure model ---------------------------------------------------------
INDOOR_OUTDOOR_RATIO = float(os.getenv("A2G_IO_RATIO", "0.6"))   # studies: ~0.4-0.9 with windows closed
SITE = {
    "school":       {"label": "School",       "people": 600, "hours": (8, 16), "shift": 1.5, "who": "students"},
    "kindergarten": {"label": "Kindergarten", "people": 100, "hours": (8, 14), "shift": 1.5, "who": "children"},
    "college":      {"label": "College",      "people": 900, "hours": (9, 17), "shift": 1.0, "who": "students"},
    "university":   {"label": "University",   "people": 900, "hours": (9, 17), "shift": 1.0, "who": "students"},
    "hospital":     {"label": "Hospital",     "people": 300, "hours": (0, 24), "shift": 0.5, "who": "patients and visitors"},
    "clinic":       {"label": "Clinic",       "people": 60,  "hours": (8, 20), "shift": 0.5, "who": "patients"},
}

# ---- Tree-equivalent --------------------------------------------------------
BLOCK_M2 = 62_500             # 250 m x 250 m block around a site
DEFAULT_MIXING_HEIGHT_M = 1000.0   # used only when live boundary-layer height is missing
TREE_G_PER_YR = 12.5          # 50 m2 canopy x 0.25 g/m2/yr. Placeholder from Nowak et al. 2013; cite locally.
TREE_CANOPY_M2 = 50
PLANTABLE_FRACTION = 0.05

# ---- Monitoring / alerts ----------------------------------------------------
# Cities the hourly monitor analyses in full and alerts on: "City,CC;City,CC" (CC = ISO-2 code)
ALERT_CITIES = os.getenv("A2G_ALERT_CITIES", "Chennai,IN;Delhi,IN")
SNS_TOPIC_ARN = os.getenv("SNS_TOPIC_ARN", "")

# ---- Storage ----------------------------------------------------------------
OPENSEARCH_URL = os.getenv("OPENSEARCH_URL", "")
OPENSEARCH_USER = os.getenv("OPENSEARCH_USER", "")
OPENSEARCH_PASSWORD = os.getenv("OPENSEARCH_PASSWORD", "")
SNAPSHOT_INDEX = "air2green-world"
EVENTS_INDEX = "air2green-events"
LOCAL_STORE = os.getenv("A2G_LOCAL_STORE", os.path.join(os.path.dirname(__file__), "..", "data", "store.json"))
