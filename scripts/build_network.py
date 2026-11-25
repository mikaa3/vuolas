"""One-time GIS & hydrological baseline builder for Finland River Flow Map.

Reads SYKE Uoma10 + Uomasolmupisteet, computes topological upstream drainage area,
fetches SYKE Virtaama stations + 15-year historical empirical percentiles, snaps
stations onto the river graph, propagates gauged corridors downstream, and writes
GeoJSONL with per-feature zoom levels ready for Tippecanoe PMTiles generation.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point, mapping

from syke_http import fetch_odata_all

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw" / "uomaverkosto"
OUT_DIR = REPO_ROOT / "data" / "processed"
ODATA_BASE = "https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata"


def compute_topological_catchment_area(rivers: gpd.GeoDataFrame, nodes: gpd.GeoDataFrame) -> pd.Series:
    """Accumulate upstream drainage area (km²) through the Uoma10 directed graph."""
    elev_map = dict(zip(nodes["uomapistei"], nodes["korkeus_m"]))

    out_edges: dict[int, list[int]] = defaultdict(list)
    in_degree: dict[int, int] = defaultdict(int)
    all_nodes: set[int] = set()

    u_arr = rivers["uomapistei"].to_numpy()
    v_arr = rivers["uomapist00"].to_numpy()
    len_km = (rivers["pituus_m"].fillna(rivers["length_m"]).fillna(1000.0) / 1000.0).to_numpy()
    paareitti = pd.to_numeric(rivers["paareitti"], errors="coerce").fillna(1).astype(int).to_numpy()

    for idx, (u, v) in enumerate(zip(u_arr, v_arr)):
        u_i, v_i = int(u), int(v)
        if u_i == v_i:
            continue
        out_edges[u_i].append(idx)
        in_degree[v_i] += 1
        all_nodes.add(u_i)
        all_nodes.add(v_i)

    # Queue headwater nodes (in_degree == 0)
    node_area: dict[int, float] = defaultdict(float)
    edge_area = np.zeros(len(rivers), dtype=float)
    visited_nodes: set[int] = set()

    q = deque([n for n in all_nodes if in_degree[n] == 0])

    def process_node(u_node: int):
        visited_nodes.add(u_node)
        e_indices = out_edges.get(u_node, [])
        if not e_indices:
            return
        # Split upstream area across outgoing branches (favor main stem paareitti == 1)
        weights = np.array([4.0 if paareitti[i] == 1 else 1.0 for i in e_indices], dtype=float)
        weights /= weights.sum()
        incoming = node_area[u_node]
        # Headwater initiation bonus (~8 km² for first-order Uoma10 streams)
        headwater_bonus = 8.0 if incoming == 0.0 else 0.0

        for w, e_idx in zip(weights, e_indices):
            local_contrib = float(len_km[e_idx]) * 2.85 + headwater_bonus * w
            total_e = incoming * float(w) + local_contrib
            edge_area[e_idx] = total_e
            v_node = int(v_arr[e_idx])
            node_area[v_node] += total_e
            in_degree[v_node] -= 1
            if in_degree[v_node] == 0 and v_node not in visited_nodes:
                q.append(v_node)

    while q:
        process_node(q.popleft())

    # Resolve any remaining flat-lake cycles ordered from highest elevation to lowest
    remaining = sorted(
        [n for n in all_nodes if n not in visited_nodes],
        key=lambda n: -(elev_map.get(n) or 0.0),
    )
    for n in remaining:
        if n not in visited_nodes:
            process_node(n)

    edge_area = np.maximum(edge_area, 10.0)
    return pd.Series(np.round(edge_area, 1), index=rivers.index)


def fetch_historical_year(year: int) -> list[dict]:
    """Fetch sampled daily Virtaama rows (days 1, 8, 15, 22 of each month) for a year."""
    start = f"{year}-01-01T00:00:00"
    end = f"{year}-12-31T23:59:59"
    flt = (
        f"Aika ge datetime'{start}' and Aika le datetime'{end}' "
        f"and (day(Aika) eq 1 or day(Aika) eq 8 or day(Aika) eq 15 or day(Aika) eq 22)"
    )
    return fetch_odata_all(ODATA_BASE, "Virtaama", {"$filter": flt, "$select": "Paikka_Id,Arvo"})


def build_station_baselines() -> tuple[gpd.GeoDataFrame, dict[str, dict], dict[int, str]]:
    print("Fetching SYKE Paikka metadata for Virtaama (Suure_Id=2)...")
    paikka_rows = fetch_odata_all(ODATA_BASE, "Paikka", {"$filter": "Suure_Id eq 2"})
    pdf = pd.DataFrame(paikka_rows).dropna(subset=["KoordErTmIta", "KoordErTmPohj"])

    # Map major basin IDs -> Finnish river basin names
    basin_names: dict[int, str] = {}
    for _, r in pdf.dropna(subset=["H_PaaVesal_Id", "PaaVesalNimi"]).iterrows():
        basin_names[int(r["H_PaaVesal_Id"])] = str(r["PaaVesalNimi"]).strip()

    print("Fetching recent 45d Virtaama to identify live active stations...")
    recent_rows = fetch_odata_all(
        ODATA_BASE,
        "Virtaama",
        {"$filter": "Aika ge datetime'2026-10-10T00:00:00'", "$select": "Paikka_Id,Arvo"},
    )
    active_ids = {int(r["Paikka_Id"]) for r in recent_rows if r.get("Arvo") is not None}
    pdf = pdf[pdf["Paikka_Id"].isin(active_ids)].copy()
    print(f"Found {len(pdf)} active Virtaama stations.")

    # Reuse cached 15y percentiles if already computed, otherwise fetch from SYKE OData
    cached_baseline_path = OUT_DIR / "stations_baseline.json"
    stats_by_pid: dict[int, dict] = {}
    if cached_baseline_path.exists():
        cached = json.loads(cached_baseline_path.read_text(encoding="utf-8"))
        for pid_s, entry in cached.items():
            if "percentiles" in entry and "mean_q" in entry:
                stats_by_pid[int(pid_s)] = {
                    "mean_q": entry["mean_q"],
                    "max_q": entry.get("max_q", entry["mean_q"] * 3),
                    "percentiles": entry["percentiles"],
                }
        print(f"Loaded cached 15-year percentiles for {len(stats_by_pid)} stations.")

    missing_pids = set(pdf["Paikka_Id"].astype(int)) - set(stats_by_pid.keys())
    if len(missing_pids) > 15:
        print("Fetching 15-year historical reference samples (2012-2026) in parallel...")
        years = list(range(2012, 2027))
        hist_rows: list[dict] = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futs = {pool.submit(fetch_historical_year, y): y for y in years}
            for fut in as_completed(futs):
                yr = futs[fut]
                res = fut.result()
                hist_rows.extend(res)
                print(f"  Year {yr}: {len(res):,} sampled observations")

        hdf = pd.DataFrame(hist_rows).dropna(subset=["Arvo"])
        hdf["Arvo"] = pd.to_numeric(hdf["Arvo"], errors="coerce")
        hdf = hdf.dropna(subset=["Arvo"])
        hdf = hdf[hdf["Arvo"] >= 0]

        for pid, grp in hdf.groupby("Paikka_Id"):
            arr = grp["Arvo"].to_numpy(dtype=float)
            if len(arr) < 20:
                continue
            pcts = np.percentile(arr, [5, 10, 25, 50, 75, 90, 95]).round(2).tolist()
            stats_by_pid[int(pid)] = {
                "mean_q": round(float(arr.mean()), 2),
                "max_q": round(float(arr.max()), 2),
                "percentiles": dict(zip(["p5", "p10", "p25", "p50", "p75", "p90", "p95"], pcts)),
            }

    pdf = pdf[pdf["Paikka_Id"].isin(stats_by_pid.keys())].copy()
    gdf = gpd.GeoDataFrame(
        pdf,
        geometry=[Point(float(x), float(y)) for x, y in zip(pdf["KoordErTmIta"], pdf["KoordErTmPohj"])],
        crs="EPSG:3067",
    )
    return gdf, {str(k): v for k, v in stats_by_pid.items()}, basin_names


def propagate_gauged_corridors(
    rivers: gpd.GeoDataFrame, direct_station_by_idx: dict[int, int]
) -> tuple[pd.Series, pd.Series]:
    """Propagate directly measured station IDs along main-stem river corridors."""
    out_edges: dict[int, list[int]] = defaultdict(list)
    u_arr = rivers["uomapistei"].to_numpy()
    v_arr = rivers["uomapist00"].to_numpy()
    area_arr = rivers["area_km2"].to_numpy()
    paareitti = pd.to_numeric(rivers["paareitti"], errors="coerce").fillna(1).astype(int).to_numpy()

    for idx, u in enumerate(u_arr):
        out_edges[int(u)].append(idx)

    corridor_station = dict(direct_station_by_idx)
    is_measured = np.zeros(len(rivers), dtype=int)
    for idx in direct_station_by_idx:
        is_measured[idx] = 1

    # Walk up to 25 topological steps downstream from each gauging station along main stem
    for start_idx, pid in direct_station_by_idx.items():
        start_area = max(area_arr[start_idx], 10.0)
        cur_node = int(v_arr[start_idx])
        for _ in range(25):
            candidates = [i for i in out_edges.get(cur_node, []) if paareitti[i] == 1]
            if not candidates:
                break
            nxt_idx = max(candidates, key=lambda i: area_arr[i])
            if nxt_idx in direct_station_by_idx:
                break  # Reached next downstream gauging station!
            # Stop propagating "measured" status if drainage area more than doubles (major confluence)
            if area_arr[nxt_idx] > start_area * 2.2:
                break
            corridor_station[nxt_idx] = pid
            is_measured[nxt_idx] = 1
            cur_node = int(v_arr[nxt_idx])

    return pd.Series(corridor_station), pd.Series(is_measured, index=rivers.index)


def minzoom_for_area(area_km2: float, is_lake: int) -> int:
    # Keep identical zoom thresholds for lake connectors so continuous corridors appear at every zoom when enabled
    if area_km2 >= 1500:
        return 4
    if area_km2 >= 400:
        return 5
    if area_km2 >= 120:
        return 6
    if area_km2 >= 45:
        return 7
    if area_km2 >= 20:
        return 8
    return 9


def main():
    t0 = time.time()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("1. Loading nationwide SYKE Uoma10 & Uomasolmupisteet...")
    rivers = gpd.read_file(RAW_DIR / "Uoma10.shp")
    nodes = gpd.read_file(RAW_DIR / "Uomasolmupisteet.shp")
    rivers = rivers.reset_index(drop=True)

    print("2. Computing topological upstream drainage areas across 42,578 reaches...")
    rivers["area_km2"] = compute_topological_catchment_area(rivers, nodes)
    uoma_cls = pd.to_numeric(rivers["uomaluokka"], errors="coerce").fillna(1).astype(int)
    rivers["is_lake"] = (uoma_cls == 2).astype(int)
    print(f"   Classified {(rivers['is_lake'] == 0).sum():,} river channels and {(rivers['is_lake'] == 1).sum():,} lake through-flow centerlines.")
    rivers["uoma_id"] = rivers["objectid"].astype(int)

    print("3. Building SYKE Virtaama station baselines...")
    stations_gdf, stats_by_pid, basin_names = build_station_baselines()

    print("4. Snapping stations to river reaches & assigning basin reference stations...")
    river_channels = rivers[rivers["is_lake"] == 0][["uoma_id", "area_km2", "paavesisto", "geometry"]]
    snapped = gpd.sjoin_nearest(
        stations_gdf,
        river_channels,
        how="inner",
        max_distance=600.0,
        distance_col="snap_m",
    ).sort_values("snap_m")
    snapped = snapped.drop_duplicates(subset=["Paikka_Id"], keep="first")

    # Map river row index -> directly snapped station
    uoma_to_row = dict(zip(rivers["uoma_id"], rivers.index))
    direct_by_row: dict[int, int] = {}
    for _, srow in snapped.sort_values("area_km2", ascending=False).iterrows():
        ridx = uoma_to_row[int(srow["uoma_id"])]
        direct_by_row[ridx] = int(srow["Paikka_Id"])

    corridor_series, measured_series = propagate_gauged_corridors(rivers, direct_by_row)
    rivers["is_measured"] = measured_series
    rivers["station_id"] = rivers.index.map(corridor_series)

    # For remaining ungauged reaches, match nearest station within same major basin (fallback: nearest overall)
    snapped_pts = snapped[["Paikka_Id", "H_PaaVesal_Id", "area_km2", "geometry"]].copy()
    missing_mask = rivers["station_id"].isna()
    nearest_global = gpd.sjoin_nearest(
        rivers.loc[missing_mask, ["uoma_id", "paavesisto", "geometry"]],
        snapped_pts[["Paikka_Id", "geometry"]],
        how="left",
    ).drop_duplicates("uoma_id")
    fallback_map = dict(zip(nearest_global["uoma_id"], nearest_global["Paikka_Id"]))

    # Basin-aware nearest match where major basin has >= 1 snapped station
    basin_matched: dict[int, int] = {}
    for basin_id, b_rivers in rivers.loc[missing_mask, ["uoma_id", "paavesisto", "geometry"]].groupby("paavesisto"):
        b_stations = snapped_pts[snapped_pts["H_PaaVesal_Id"] == basin_id]
        if len(b_stations) > 0:
            joined = gpd.sjoin_nearest(b_rivers, b_stations[["Paikka_Id", "geometry"]], how="left").drop_duplicates("uoma_id")
            basin_matched.update(dict(zip(joined["uoma_id"], joined["Paikka_Id"])))

    def resolve_station(row) -> int:
        if pd.notna(row["station_id"]):
            return int(row["station_id"])
        uid = int(row["uoma_id"])
        return int(basin_matched.get(uid) or fallback_map.get(uid))

    rivers["station_id"] = rivers.apply(resolve_station, axis=1)

    # Save enriched stations_baseline.json (with WGS84 coords + snapped drainage area)
    snapped_wgs = snapped.to_crs("EPSG:4326")
    baseline_out: dict[str, dict] = {}
    for _, row in snapped_wgs.iterrows():
        pid_str = str(int(row["Paikka_Id"]))
        st_stats = stats_by_pid[pid_str]
        # Calibrate station reference area so Q = area_km2 * runoff / 1000 matches measured Q at the gauge!
        snapped_area = max(float(row["area_km2"]), 10.0)
        baseline_out[pid_str] = {
            "name": str(row["Nimi"]).strip(),
            "municipality": str(row.get("KuntaNimi") or "").strip(),
            "basin": str(row.get("PaaVesalNimi") or "").strip(),
            "sub_basin": str(row.get("VesalNimi") or "").strip(),
            "lon": round(float(row.geometry.x), 5),
            "lat": round(float(row.geometry.y), 5),
            "area_km2": round(snapped_area, 1),
            **st_stats,
        }

    (OUT_DIR / "stations_baseline.json").write_text(
        json.dumps(baseline_out, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Saved {len(baseline_out)} calibrated stations to stations_baseline.json")

    print("5. Simplifying geometries & writing WGS84 GeoJSONSeq with Tippecanoe minzoom...")
    rivers["geometry"] = rivers.geometry.simplify(tolerance=18.0, preserve_topology=True)
    rivers_wgs = rivers.to_crs("EPSG:4326")

    geojsonl_path = OUT_DIR / "rivers_wgs84.geojsonl"
    with geojsonl_path.open("w", encoding="utf-8") as fh:
        for row in rivers_wgs.itertuples():
            if row.geometry is None or row.geometry.is_empty:
                continue
            b_id = int(row.paavesisto) if pd.notna(row.paavesisto) else 0
            feat = {
                "type": "Feature",
                "id": int(row.uoma_id),
                "tippecanoe": {
                    "minzoom": minzoom_for_area(float(row.area_km2), int(row.is_lake)),
                    "maxzoom": 12,
                },
                "properties": {
                    "uoma_id": int(row.uoma_id),
                    "area_km2": round(float(row.area_km2), 1),
                    "len_km": round(float(row.pituus_m or 0.0) / 1000.0, 2),
                    "is_lake": int(row.is_lake),
                    "is_measured": int(row.is_measured),
                    "station_id": int(row.station_id),
                    "basin": basin_names.get(b_id, "Rannikko / Vesistö"),
                },
                "geometry": mapping(row.geometry),
            }
            fh.write(json.dumps(feat, ensure_ascii=False, separators=(",", ":")) + "\n")

    print(f"Network build complete in {time.time() - t0:.1f}s -> {geojsonl_path}")


if __name__ == "__main__":
    main()
