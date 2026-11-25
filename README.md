# Vuolas — Suomen jokivirtaamat

**Vuolas** (*Finnish for swift-flowing, abundant current*) is a serverless interactive WebGL visualization of live river discharge (`m³/s`), historical flow percentiles (`p1–p99`), and national hydrological metrics across **42,578 Finnish river and lake-route segments**.

## Features
- **Nationwide River Graph:** 25,504 true river channels (`uomaluokka = 1`) and 17,074 toggleable lake through-flow centerlines (`uomaluokka = 2`) with topological upstream drainage areas (`km²`).
- **3 Visual Encoding Modes:** **Percentile** (drought vs. flood relative to each river's 15-year empirical history), **Volume (`m³/s`)**, and **None** (plain cartographic river geometry).
- **60 FPS Downstream Flow Animation:** HiDPI canvas current droplets streaming strictly downstream at discharge-scaled velocities.
- **Live Metrics Dashboard (`Metrics`):** 30-day national aggregate discharge trend, flow regime histogram, major watershed comparison, and clickable leaderboards for highest-volume and fastest-surging rivers.
- **Beginner's Hydrology Guide (`? Guide`):** Built-in plain-language glossary covering all map controls and hydrological terms.

## Data Sources (CC BY 4.0)
- **River Network & Topology:** [SYKE Uomaverkosto (`Uoma10` & `Uomasolmupisteet`)](https://www.syke.fi/avointieto) (derived from Maanmittauslaitos Topographic Database, `EPSG:3067`)
- **Live & Historical Discharge (`Virtaama`):** [SYKE Hydrologiarajapinta OData API](https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/) (~420 active gauging stations calibrated against 15-year empirical percentiles)
- **Basemap Vector Tiles:** [OpenFreeMap](https://openfreemap.org/) (OpenStreetMap contributors)

## Local Development

```bash
# 1. Refresh live SYKE flows (~2 seconds)
uv run python scripts/fetch_live_flows.py
cp data/live/*.json web/public/data/

# 2. Launch Vite dev server
cd web && npm run dev
```

To rebuild the nationwide `finland_rivers.pmtiles` and 15-year station baseline from scratch:

```bash
uv run python scripts/build_network.py
tippecanoe -P -o data/processed/finland_rivers.pmtiles -l rivers -Z 4 -z 12 \
  --no-feature-limit --no-tile-size-limit --force data/processed/rivers_wgs84.geojsonl
cp data/processed/finland_rivers.pmtiles web/public/data/
```

## Deployment (GitHub + Cloudflare Pages — \$0/month, No Credit Card)
1. **Static Frontend & `PMTiles`:** Hosted on **Cloudflare Pages** (root directory: `web`, build command: `npm run build`, output: `dist`), serving both the UI and `finland_rivers.pmtiles` (19.65 MiB) directly from Cloudflare's edge.
2. **Hourly Live SYKE Data:** `.github/workflows/update-flows.yml` runs hourly on GitHub Actions and publishes `latest_flows.json` and `station_series.json` to an orphan single-commit `live-data` branch. Set `VITE_FLOWS_BASE_URL=https://raw.githubusercontent.com/<USER>/<REPO>/live-data` in Cloudflare Pages environment variables.
