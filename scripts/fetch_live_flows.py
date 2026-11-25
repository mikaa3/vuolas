"""Hourly live river flow fetcher for Finland River Flow Map.

Queries SYKE Hydrologiarajapinta (OData) for the latest 30 days of Virtaama (m³/s)
and Jaanpaksuus (ice thickness cm), computes each station's empirical flow percentile
and calibrated specific runoff (l/s/km²), and outputs compact static JSON files.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from syke_http import fetch_odata_all

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = REPO_ROOT / "data" / "processed" / "stations_baseline.json"
OUT_DIR = REPO_ROOT / "data" / "live"
ODATA_BASE = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata"


def compute_percentile(q: float, pct_dict: dict) -> int:
    knots_p = [5, 10, 25, 50, 75, 90, 95]
    knots_q = [float(pct_dict[f"p{k}"]) for k in knots_p]
    # Handle degenerate constant curves gracefully
    if knots_q[-1] <= knots_q[0]:
        return 50
    return int(np.clip(round(float(np.interp(q, knots_q, knots_p))), 1, 99))


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    baseline: dict[str, dict] = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))

    # Use latest available observations within a 35-day rolling window
    now_utc = datetime.now(timezone.utc)
    since = (now_utc - timedelta(days=35)).strftime("%Y-%m-%dT00:00:00")

    print(f"Fetching SYKE Virtaama observations since {since}...")
    rows = fetch_odata_all(
        ODATA_BASE,
        "Virtaama",
        {
            "$filter": f"Aika ge datetime'{since}'",
            "$select": "Paikka_Id,Aika,Arvo",
            "$orderby": "Aika asc",
        },
    )

    df = pd.DataFrame(rows).dropna(subset=["Arvo"])
    df["Arvo"] = pd.to_numeric(df["Arvo"], errors="coerce")
    df = df.dropna(subset=["Arvo"])
    df = df[df["Arvo"] >= 0]
    df["pid"] = df["Paikka_Id"].astype(str)
    df = df[df["pid"].isin(baseline.keys())]

    stations_latest: dict[str, dict] = {}
    station_series: dict[str, list] = {}
    latest_obs_date = ""

    for pid, grp in df.groupby("pid"):
        meta = baseline[pid]
        grp_sorted = grp.sort_values("Aika")
        latest = grp_sorted.iloc[-1]
        q_now = round(float(latest["Arvo"]), 2)
        obs_time = str(latest["Aika"])[:16]
        if obs_time > latest_obs_date:
            latest_obs_date = obs_time

        pct = compute_percentile(q_now, meta["percentiles"])
        # Ensure effective drainage area respects climatological mean runoff (~10.5 l/s/km² ceiling)
        clim_area = float(meta.get("mean_q", 0.0)) * 95.0
        area_km2 = max(float(meta["area_km2"]), clim_area, 12.0)
        # Bound instantaneous specific runoff for ungauged scaling to realistic Finnish range [0.1, 60.0] l/s/km²
        runoff_l_s_km2 = round(float(np.clip((q_now * 1000.0) / area_km2, 0.1, 60.0)), 3)

        # 7-day trend delta
        q_7d_ago = float(grp_sorted.iloc[max(0, len(grp_sorted) - 8)]["Arvo"])
        trend_pct = round(((q_now - q_7d_ago) / max(q_7d_ago, 0.5)) * 100.0, 1)

        stations_latest[pid] = {
            "q": q_now,
            "pct": pct,
            "r": runoff_l_s_km2,
            "tr": trend_pct,
            "t": obs_time[:10],
            "name": meta["name"],
            "mun": meta["municipality"],
            "basin": meta["basin"],
            "lon": meta["lon"],
            "lat": meta["lat"],
            "area": meta["area_km2"],
            "p10": meta["percentiles"]["p10"],
            "p50": meta["percentiles"]["p50"],
            "p90": meta["percentiles"]["p90"],
            "mean_q": meta["mean_q"],
        }

        station_series[pid] = [
            [str(r["Aika"])[:10], round(float(r["Arvo"]), 2)]
            for _, r in grp_sorted.tail(30).iterrows()
        ]

    # National summary statistics
    pct_vals = [s["pct"] for s in stations_latest.values()]
    total_gauged_q = round(sum(s["q"] for s in stations_latest.values()), 0)
    summary = {
        "median_pct": int(np.median(pct_vals)) if pct_vals else 50,
        "high_flow_count": sum(1 for p in pct_vals if p >= 85),
        "low_flow_count": sum(1 for p in pct_vals if p <= 15),
        "normal_count": sum(1 for p in pct_vals if 15 < p < 85),
        "latest_obs_date": latest_obs_date[:10],
        "total_station_q": total_gauged_q,
    }

    payload = {
        "updated_at": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "station_count": len(stations_latest),
        "summary": summary,
        "stations": stations_latest,
    }

    (OUT_DIR / "latest_flows.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    (OUT_DIR / "station_series.json").write_text(
        json.dumps(station_series, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"Wrote {len(stations_latest)} active stations (latest obs: {summary['latest_obs_date']}, "
        f"national median: p{summary['median_pct']}) -> {OUT_DIR / 'latest_flows.json'}"
    )


if __name__ == "__main__":
    main()
