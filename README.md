# AIR2GREEN

**Live air quality for every country. What to do on bad-air days, and where to plant trees.**

Problem statement: *when air pollution becomes hazardous, people and institutions can see the
air is bad but can't understand the burden, choose a local response, or measure whether it
helped.* AIR2GREEN answers it for any city on the planet, with live data and no demo data.

## What you see

**World** – every country coloured by PM2.5 at its capital right now, with "worst now",
"getting worse in the next 24 h" and "cleanest" lists. Small countries appear as dots.

**Country** – all major cities on a map and ranked, with each city's next-24-hour peak.

**City** – one page that reads top to bottom:
1. **Detect** – current band, 3-day hourly forecast, alert now or coming, best 2-hour window outdoors.
2. **Explain** – likely cause from live signals (wind, mixing height, dust share, carbon
   monoxide) and who is exposed: schools, colleges, hospitals and clinics within 2 km, from
   OpenStreetMap, flagged when within 60 m of a major road.
3. **Act** – actions for schools, hospitals, everyone and city officials, scaled to the
   severity; tick sites off as they act.
4. **Measure** – exposure avoided if sites act (person-hours moved indoors, % less PM2.5
   breathed), and how many have confirmed.
5. **Long term: plant** – the five sites where planting protects most people (Green Gap),
   with layout, what to avoid, species guidance and the tree-equivalent of the local burden.

Search any country or city, or use **My location**. Data refreshes every 15 minutes, and
again when you come back to the tab.

## Live data sources (free, no API keys)

| Data | Source |
|---|---|
| PM2.5, PM10, dust, carbon monoxide: now, past 24 h, 4-day hourly forecast | Copernicus Atmosphere Monitoring Service (CAMS) via the [Open-Meteo air-quality API](https://open-meteo.com/en/docs/air-quality-api) |
| Wind speed, boundary-layer (mixing) height | Open-Meteo weather API |
| Schools, hospitals, major roads, parks | OpenStreetMap via the Overpass API |
| Country shapes / capitals and cities | Natural Earth (world-atlas) / GeoNames, bundled |

CAMS values are model estimates for a 10–45 km grid cell, not readings from one monitor.
Open-Meteo is free for non-commercial use within its fair-use limits (about 10,000 calls a
day per user); the app caches results in the browser to stay well inside them.

## Run the app

The app is a static site in `web/`. It needs an internet connection and nothing else.

- **Quickest:** double-click `web/index.html` (Chrome, Edge, Firefox or Safari).
- **Local server** (needed for "My location" in some browsers):
  `cd web && python -m http.server 8000`, then open http://localhost:8000
- **Host it on AWS:** `sam deploy` creates an S3 website bucket (see below), then
  `aws s3 sync web/ s3://<WebBucketName>`. Any static host (GitHub Pages, Vercel, Netlify) also works.

## Backend on AWS (open-source tools)

| Tool | Job |
|---|---|
| **Strands Agents SDK** | `agent/agent.py`: 7 tools, all live (world air, country cities, city analysis, sites, planting plan, tree-equivalent, alert history) |
| **OpenSearch** (+ Dashboards) | Hourly world snapshots (`geo_point`) and the alert event log |
| **SAM CLI** | `template.yaml`: hourly monitor Lambda on EventBridge, SNS email alerts, API Gateway, S3 web hosting |
| **Powertools for AWS Lambda** | Structured logs and tracing |

The hourly monitor saves PM2.5 for every capital to OpenSearch, analyses the cities in
`AlertCities` (default `Chennai,IN;Delhi,IN`), emails an alert when a new bad-air period starts
or is forecast within 48 h, and an all-clear with the exposure estimate when it ends.

```bash
pip install -r requirements.txt
python -m air2green.service Chennai IN        # live report for any city, printed as the alert text
python -m air2green.service monitor           # one monitor run (stores locally without OpenSearch)

docker compose up -d                          # optional local OpenSearch :9200 + Dashboards :5601
export OPENSEARCH_URL=http://localhost:9200

export AWS_REGION=us-east-1 A2G_MODEL_ID=<a Bedrock model id you can use>
python -m agent.agent "Is the air in Lahore dangerous today, and what should schools do?"

sam build && sam deploy --guided              # asks for AlertEmail, AlertCities, OpenSearchUrl...
aws s3 sync web/ s3://<WebBucketName>         # publish the app
```

API routes: `/world`, `/city?name=Chennai&country=IN` (or `lat`, `lon`), `/events`, `/plan?name=…`.

## The numbers, honestly

- **Scales:** India uses the CPCB National AQI; everywhere else uses the US EPA AQI (2024
  breakpoints). Switch with the scale menu. The world map uses one scale so countries compare
  fairly. Both scales are defined for 24-hour averages; the app applies them to hourly values
  as a guide.
- **Alert level:** above 90 µg/m³ (CPCB "Poor") or 35.4 µg/m³ (EPA "Unhealthy for sensitive
  groups"), the point where children's outdoor activity should move indoors. An alert ends
  after 2 clean hours.
- **Likely cause** is a simple rule set on model signals (dust share of PM10, wind below 2 m/s
  or mixing height below 300 m, carbon monoxide above 500 µg/m³ at or outside rush hour). It is a
  lead to check, not source apportionment.
- **Exposure avoided** counts only the outdoor time an action moves indoors (schools 1.5 h,
  colleges 1 h, health sites 0.5 h) during local opening hours, at 0.6× the outdoor level with
  windows closed (studies report roughly 0.4–0.9). Head counts use OpenStreetMap capacity tags
  where mapped, otherwise typical sizes. Assumes a normal working day.
- **Tree-equivalent** = (excess PM2.5 above WHO's 15 µg/m³ × 62,500 m² block × live mixing
  height × 10⁻⁶) ÷ 12.5 g per tree per year. The removal rate is a placeholder from Nowak et
  al. 2013; replace it with a locally cited value. It is an awareness figure; cutting the
  source matters most.
- **Placement rules** follow Abhijith et al. 2017: dense continuous barriers along open
  roads; no tall closed canopies over narrow built-up streets.
- **Species:** a shortlist for India; elsewhere, functional guidance plus "ask the local
  forestry department", since one global list would be wrong.

## Tests

```bash
python -m pytest -q                 # backend logic + end-to-end with recorded-shape API responses
pip install playwright && python tests/browser_check.py   # app in a headless browser
```
Tests replace the network with synthetic responses shaped like Open-Meteo and Overpass
(`tests/fakeapi.py`). That file is used only by tests; the app and backend never fall back to it.

## Rebuild the bundled place data (optional)

`scripts/build_places.py` and `scripts/simplify.js` regenerate `web/geo.js` and
`air2green/data/places.json` from world-atlas and GeoNames (instructions in the script).

 tool calls, OpenSearch snapshots.
