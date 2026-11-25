import maplibregl from "maplibre-gl";

function resolveBaseUrl(raw) {
  const trimmed = (raw || "/data").replace(/\/$/, "");
  return trimmed.startsWith("http")
    ? trimmed
    : new URL(trimmed, window.location.origin).href.replace(/\/$/, "");
}

const TILES_BASE = resolveBaseUrl(import.meta.env.VITE_TILES_BASE_URL || "/data");
const FLOWS_BASE = resolveBaseUrl(import.meta.env.VITE_FLOWS_BASE_URL || import.meta.env.VITE_DATA_BASE_URL || "/data");

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [25.6, 64.6],
  zoom: 5.15,
  minZoom: 4,
  maxZoom: 13,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

let flowData = null;
let seriesCache = null;
let colorMode = "pct";
let animEnabled = true;
let showLakes = false;
let currentPctMatch = 50;
let currentQExpr = 10;

// --- MapLibre Style Expressions (top-level ["zoom"] compliant) ---

function buildStationExpressions(stations) {
  const runoffMatch = ["match", ["get", "station_id"]];
  const pctMatch = ["match", ["get", "station_id"]];

  for (const [pid, s] of Object.entries(stations)) {
    const idNum = Number(pid);
    runoffMatch.push(idNum, Math.max(Number(s.r) || 0.1, 0.05));
    pctMatch.push(idNum, Number(s.pct) || 50);
  }
  runoffMatch.push(8.0);
  pctMatch.push(50);
  return { runoffMatch, pctMatch };
}

function makeWidthExpr(qExpr, scale = 1.0, minFloor = 0.55) {
  // ["zoom"] MUST be the direct input of the top-level interpolate expression
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    4, ["max", minFloor, ["*", +(0.42 * scale).toFixed(3), ["ln", ["+", qExpr, 1.4]]]],
    7, ["max", +(minFloor * 1.4).toFixed(2), ["*", +(0.85 * scale).toFixed(3), ["ln", ["+", qExpr, 1.4]]]],
    11, ["max", +(minFloor * 2.2).toFixed(2), ["*", +(1.9 * scale).toFixed(3), ["ln", ["+", qExpr, 1.4]]]],
  ];
}

function makeUniformWidthExpr() {
  return ["interpolate", ["linear"], ["zoom"], 4, 0.8, 7, 1.25, 11, 2.0];
}

function getColorExpr(mode, pctExpr, qExpr) {
  if (mode === "none") {
    return "#38bdf8";
  }
  if (mode === "pct") {
    return [
      "interpolate",
      ["linear"],
      pctExpr,
      8, "#f59e0b",
      25, "#eab308",
      50, "#22d3ee",
      75, "#3b82f6",
      92, "#c084fc",
    ];
  }
  return [
    "interpolate",
    ["exponential", 1.35],
    qExpr,
    0.8, "#0e7490",
    10, "#06b6d4",
    50, "#3b82f6",
    220, "#a855f7",
    700, "#f43f5e",
  ];
}

function getStationColorExpr(mode) {
  if (mode === "none") {
    return "#e2e8f0";
  }
  if (mode === "abs") {
    return [
      "interpolate",
      ["exponential", 1.35],
      ["max", ["get", "q"], 0.1],
      0.8, "#0e7490",
      10, "#06b6d4",
      50, "#3b82f6",
      220, "#a855f7",
      700, "#f43f5e",
    ];
  }
  return [
    "interpolate",
    ["linear"],
    ["get", "pct"],
    8, "#f59e0b",
    25, "#eab308",
    50, "#22d3ee",
    75, "#3b82f6",
    92, "#c084fc",
  ];
}

function colorForSegment(pct, q) {
  if (colorMode === "none") {
    return "#7dd3fc";
  }
  if (colorMode === "pct") {
    if (pct <= 15) return "#fbbf24";
    if (pct <= 35) return "#fde047";
    if (pct <= 68) return "#67e8f9";
    if (pct <= 86) return "#93c5fd";
    return "#e9d5ff";
  }
  if (q < 5) return "#67e8f9";
  if (q < 40) return "#38bdf8";
  if (q < 180) return "#93c5fd";
  if (q < 450) return "#d8b4fe";
  return "#fda4af";
}

function buildStationsGeoJSON(stations) {
  return {
    type: "FeatureCollection",
    features: Object.entries(stations).map(([pid, s]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        station_id: Number(pid),
        name: s.name,
        basin: s.basin,
        mun: s.mun,
        q: s.q,
        pct: s.pct,
        area_km2: s.area,
        is_measured: 1,
      },
    })),
  };
}

function softenBasemapRoads() {
  const layers = map.getStyle()?.layers || [];
  for (const lyr of layers) {
    if (lyr.id.includes("highway") || lyr.id.includes("road") || lyr.id.includes("transportation")) {
      if (lyr.type === "line") {
        map.setPaintProperty(lyr.id, "line-opacity", 0.16);
      }
    }
  }
}

// --- 60 FPS Canvas Downstream Flow Comet Engine ---

const flowCanvas = document.getElementById("flow-canvas");
const ctx = flowCanvas.getContext("2d");
let flowPaths = [];
let rafId = null;
let lastFrameMs = 0;
let isMapMoving = false;
let rebuildTimer = null;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = flowCanvas.clientWidth || window.innerWidth;
  const h = flowCanvas.clientHeight || window.innerHeight;
  flowCanvas.width = Math.round(w * dpr);
  flowCanvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener("resize", () => {
  resizeCanvas();
  scheduleFlowRebuild(80);
});
resizeCanvas();

function extractCoordLines(geom) {
  if (!geom) return [];
  if (geom.type === "LineString") return [geom.coordinates];
  if (geom.type === "MultiLineString") return geom.coordinates;
  return [];
}

function rebuildFlowPaths() {
  if (!animEnabled || !flowData || !map.getLayer("rivers-base")) {
    flowPaths = [];
    ctx.clearRect(0, 0, flowCanvas.clientWidth, flowCanvas.clientHeight);
    return;
  }

  const zoom = map.getZoom();
  const minArea = zoom < 5.5 ? 250 : zoom < 7 ? 75 : zoom < 8.5 ? 25 : 10;
  const feats = map.queryRenderedFeatures({ layers: ["rivers-base"] });

  const newPaths = [];
  const seenKeys = new Set();

  for (const f of feats) {
    const p = f.properties;
    const area = Number(p.area_km2) || 10;
    if (area < minArea) continue;
    if (!showLakes && Number(p.is_lake) === 1) continue;

    const lines = extractCoordLines(f.geometry);
    const st = flowData.stations[String(p.station_id)];
    const r = st ? Math.max(Number(st.r) || 1, 0.2) : 8.0;
    const pct = st ? Number(st.pct) || 50 : 50;
    const q = p.is_measured && st ? Number(st.q) : (area * r) / 1000;

    for (let li = 0; li < lines.length; li++) {
      const coords = lines[li];
      if (coords.length < 2) continue;

      // Deduplicate identical tile-clipped geometry parts
      const c0 = coords[0];
      const cN = coords[coords.length - 1];
      const dedupKey = `${p.uoma_id}_${c0[0].toFixed(4)}_${c0[1].toFixed(4)}_${cN[0].toFixed(4)}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      const n = coords.length;
      const xs = new Float32Array(n);
      const ys = new Float32Array(n);
      const cum = new Float32Array(n);
      let totalLen = 0;

      for (let i = 0; i < n; i++) {
        const pt = map.project(coords[i]);
        xs[i] = pt.x;
        ys[i] = pt.y;
        if (i > 0) {
          totalLen += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
          cum[i] = totalLen;
        }
      }

      if (totalLen < 14) continue;

      const isPlain = colorMode === "none";
      const logQ = Math.log10(Math.max(q, 0.5) + 1.5);
      const speed = isPlain ? 24 : 18 + 20 * logQ; // px/sec downstream
      const tailLen = Math.min(totalLen * 0.45, isPlain ? 14 : 10 + 9 * logQ);
      const spacing = isPlain ? 68 : Math.max(42, 82 - 8 * logQ);
      const width = isPlain ? 1.25 : Math.min(3.2, 1.0 + 0.55 * logQ);
      const count = Math.max(1, Math.min(12, Math.floor(totalLen / spacing)));
      const seedOffset = ((Number(p.uoma_id) * 2654435761) >>> 0) / 4294967296;

      newPaths.push({
        xs,
        ys,
        cum,
        totalLen,
        speed,
        tailLen,
        width,
        count,
        seedOffset,
        color: colorForSegment(pct, q),
      });
    }
  }

  flowPaths = newPaths;
}

function samplePointAtDist(path, d, out) {
  const { xs, ys, cum } = path;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / segLen;
  out.x = xs[lo] + (xs[hi] - xs[lo]) * t;
  out.y = ys[lo] + (ys[hi] - ys[lo]) * t;
}

function drawSubPath(path, dStart, dEnd) {
  const { xs, ys, cum } = path;
  const pt = { x: 0, y: 0 };
  ctx.beginPath();
  samplePointAtDist(path, dStart, pt);
  ctx.moveTo(pt.x, pt.y);

  for (let i = 1; i < cum.length - 1; i++) {
    if (cum[i] > dStart && cum[i] < dEnd) {
      ctx.lineTo(xs[i], ys[i]);
    }
  }
  samplePointAtDist(path, dEnd, pt);
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
}

function renderFlowFrame(nowMs) {
  if (!animEnabled) {
    rafId = null;
    return;
  }
  rafId = requestAnimationFrame(renderFlowFrame);

  if (nowMs - lastFrameMs < 16) return; // Cap ~60 FPS
  lastFrameMs = nowMs;

  const w = flowCanvas.clientWidth;
  const h = flowCanvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (isMapMoving || !flowPaths.length) return;

  const tSec = nowMs * 0.001;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const headPt = { x: 0, y: 0 };

  for (let i = 0; i < flowPaths.length; i++) {
    const p = flowPaths[i];
    const cycleLen = p.totalLen + p.tailLen;

    for (let c = 0; c < p.count; c++) {
      const phase = (p.seedOffset + c / p.count) % 1;
      const headDist = (phase * cycleLen + tSec * p.speed) % cycleLen;
      const dEnd = Math.min(headDist, p.totalLen);
      const dStart = Math.max(0, headDist - p.tailLen);

      if (dEnd - dStart < 1.5) continue;

      // Fade smoothly at segment entry and exit
      const edgeFade =
        Math.min(1, dEnd / 10) * Math.min(1, (p.totalLen - dStart) / 10);

      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.72 * edgeFade;
      ctx.lineWidth = p.width;
      drawSubPath(p, dStart, dEnd);

      // Bright leading droplet head moving strictly downstream
      if (headDist <= p.totalLen) {
        samplePointAtDist(p, dEnd, headPt);
        ctx.fillStyle = "#ffffff";
        ctx.globalAlpha = 0.9 * edgeFade;
        ctx.beginPath();
        ctx.arc(headPt.x, headPt.y, p.width * 0.78, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function startFlowLoop() {
  flowCanvas.style.opacity = "1";
  rebuildFlowPaths();
  if (!rafId) {
    lastFrameMs = 0;
    rafId = requestAnimationFrame(renderFlowFrame);
  }
}

function stopFlowLoop() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  flowPaths = [];
  ctx.clearRect(0, 0, flowCanvas.clientWidth, flowCanvas.clientHeight);
  flowCanvas.style.opacity = "0";
}

function scheduleFlowRebuild(delayMs = 90) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    isMapMoving = false;
    if (animEnabled) rebuildFlowPaths();
  }, delayMs);
}

// --- Bind UI Controls Immediately ---

setupUIControls();

map.on("movestart", () => {
  isMapMoving = true;
  ctx.clearRect(0, 0, flowCanvas.clientWidth, flowCanvas.clientHeight);
});

map.on("moveend", () => scheduleFlowRebuild(60));
map.on("idle", () => {
  if (animEnabled && flowPaths.length === 0) {
    isMapMoving = false;
    rebuildFlowPaths();
  }
});

map.on("load", async () => {
  softenBasemapRoads();

  const resp = await fetch(`${FLOWS_BASE}/latest_flows.json`);
  flowData = await resp.json();

  const sum = flowData.summary || {};
  document.getElementById("status-line").textContent =
    `SYKE Open Data · Latest obs ${sum.latest_obs_date || flowData.updated_at.slice(0, 10)}`;
  document.getElementById("kpi-stations").textContent = flowData.station_count;
  document.getElementById("kpi-median").textContent = `p${sum.median_pct ?? 50}`;
  document.getElementById("kpi-high").textContent = sum.high_flow_count ?? 0;
  document.getElementById("kpi-low").textContent = sum.low_flow_count ?? 0;

  const { runoffMatch, pctMatch } = buildStationExpressions(flowData.stations);
  currentPctMatch = pctMatch;
  currentQExpr = ["*", ["get", "area_km2"], ["/", runoffMatch, 1000]];

  map.addSource("finland-rivers", {
    type: "vector",
    tiles: [`${TILES_BASE}/tiles/{z}/{x}/{y}.pbf`],
    minzoom: 4,
    maxzoom: 10,
    bounds: [19.6, 59.83, 34.68, 70.5],
    attribution: "SYKE & MML (CC BY 4.0)",
  });

  map.addSource("syke-stations", {
    type: "geojson",
    data: buildStationsGeoJSON(flowData.stations),
  });

  // Outer river glow on major channels (valid top-level ["zoom"] expression)
  map.addLayer({
    id: "rivers-glow",
    type: "line",
    source: "finland-rivers",
    "source-layer": "rivers",
    filter: ["all", ["==", ["get", "is_lake"], 0], [">=", ["get", "area_km2"], 150]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": getColorExpr(colorMode, currentPctMatch, currentQExpr),
      "line-width": makeWidthExpr(currentQExpr, 2.4, 1.3),
      "line-blur": 4,
      "line-opacity": 0.22,
    },
  });

  // Core river network layer
  map.addLayer({
    id: "rivers-base",
    type: "line",
    source: "finland-rivers",
    "source-layer": "rivers",
    filter: showLakes ? ["all"] : ["==", ["get", "is_lake"], 0],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": getColorExpr(colorMode, currentPctMatch, currentQExpr),
      "line-width": makeWidthExpr(currentQExpr, 1.0, 0.55),
      "line-opacity": [
        "case",
        ["==", ["get", "is_lake"], 1],
        0.62,
        ["==", ["get", "is_measured"], 1],
        0.92,
        0.68,
      ],
    },
  });

  // SYKE Gauging station dots
  map.addLayer({
    id: "stations-circle",
    type: "circle",
    source: "syke-stations",
    minzoom: 5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 9, 5.5],
      "circle-color": getStationColorExpr(colorMode),
      "circle-stroke-color": "#090e17",
      "circle-stroke-width": 1.3,
      "circle-opacity": 0.95,
    },
  });

  setupInteractions();
  setupSearch();

  // Kick off flow animation once initial vector tiles finish rendering
  map.once("idle", () => {
    if (animEnabled) startFlowLoop();
  });
});

function setupUIControls() {
  const btnPct = document.getElementById("mode-pct");
  const btnAbs = document.getElementById("mode-abs");
  const btnNone = document.getElementById("mode-none");
  const legendBox = document.getElementById("legend-box");
  const bar = document.getElementById("legend-bar");
  const ticks = document.getElementById("legend-ticks");

  function applyMode(mode) {
    colorMode = mode;
    btnPct.classList.toggle("active", mode === "pct");
    btnAbs.classList.toggle("active", mode === "abs");
    btnNone.classList.toggle("active", mode === "none");

    if (mode === "none") {
      legendBox.style.display = "none";
    } else {
      legendBox.style.display = "block";
      bar.className = `legend-bar ${mode === "pct" ? "pct-gradient" : "abs-gradient"}`;
      ticks.innerHTML =
        mode === "pct"
          ? "<span>p10 Dry</span><span>p50 Normal</span><span>p90 Flood</span>"
          : "<span>1 m³/s</span><span>50 m³/s</span><span>500+ m³/s</span>";
    }

    if (map.getLayer("rivers-base")) {
      const expr = getColorExpr(mode, currentPctMatch, currentQExpr);
      map.setPaintProperty("rivers-base", "line-color", expr);
      map.setPaintProperty(
        "rivers-base",
        "line-width",
        mode === "none" ? makeUniformWidthExpr() : makeWidthExpr(currentQExpr, 1.0, 0.55)
      );
      map.setPaintProperty(
        "rivers-base",
        "line-opacity",
        mode === "none"
          ? ["case", ["==", ["get", "is_lake"], 1], 0.62, 0.85]
          : ["case", ["==", ["get", "is_lake"], 1], 0.62, ["==", ["get", "is_measured"], 1], 0.92, 0.68]
      );
      map.setLayoutProperty("rivers-glow", "visibility", mode === "none" ? "none" : "visible");
      if (mode !== "none") {
        map.setPaintProperty("rivers-glow", "line-color", expr);
      }
      map.setPaintProperty("stations-circle", "circle-color", getStationColorExpr(mode));
    }
    if (animEnabled) rebuildFlowPaths();
  }

  btnPct.addEventListener("click", () => applyMode("pct"));
  btnAbs.addEventListener("click", () => applyMode("abs"));
  btnNone.addEventListener("click", () => applyMode("none"));

  document.getElementById("toggle-anim").addEventListener("change", (e) => {
    animEnabled = e.target.checked;
    if (animEnabled) {
      startFlowLoop();
    } else {
      stopFlowLoop();
    }
  });

  document.getElementById("toggle-stations").addEventListener("change", (e) => {
    if (map.getLayer("stations-circle")) {
      map.setLayoutProperty("stations-circle", "visibility", e.target.checked ? "visible" : "none");
    }
  });

  document.getElementById("toggle-lakes").addEventListener("change", (e) => {
    showLakes = e.target.checked;
    if (map.getLayer("rivers-base")) {
      map.setFilter("rivers-base", showLakes ? ["all"] : ["==", ["get", "is_lake"], 0]);
      map.once("idle", () => {
        if (animEnabled) rebuildFlowPaths();
      });
    }
  });

  document.querySelectorAll("#river-chips button").forEach((btn) => {
    btn.addEventListener("click", () => {
      map.flyTo({
        center: [Number(btn.dataset.lon), Number(btn.dataset.lat)],
        zoom: Number(btn.dataset.z),
        duration: 1300,
      });
    });
  });

  const railBody = document.getElementById("rail-body");
  const collapseBtn = document.getElementById("btn-collapse");
  collapseBtn.addEventListener("click", () => {
    const hidden = railBody.style.display === "none";
    railBody.style.display = hidden ? "block" : "none";
    collapseBtn.textContent = hidden ? "−" : "+";
  });

  const infoModal = document.getElementById("info-modal");
  const btnInfo = document.getElementById("btn-info");
  const btnCloseInfo = document.getElementById("btn-close-info");

  const metricsModal = document.getElementById("metrics-modal");
  const btnMetrics = document.getElementById("btn-metrics");
  const btnCloseMetrics = document.getElementById("btn-close-metrics");

  btnInfo.addEventListener("click", () => {
    metricsModal.classList.remove("open");
    if (flowData) {
      document.getElementById("arch-live-sync").textContent =
        `Live feed synced: ${flowData.updated_at} · ${flowData.station_count} active SYKE stations`;
    }
    infoModal.classList.add("open");
  });
  btnCloseInfo.addEventListener("click", () => infoModal.classList.remove("open"));
  infoModal.addEventListener("click", (e) => {
    if (e.target === infoModal) infoModal.classList.remove("open");
  });

  const tabGuide = document.getElementById("tab-guide");
  const tabArch = document.getElementById("tab-arch");
  const paneGuide = document.getElementById("pane-guide");
  const paneArch = document.getElementById("pane-arch");
  tabGuide.addEventListener("click", () => {
    tabGuide.classList.add("active");
    tabArch.classList.remove("active");
    paneGuide.style.display = "block";
    paneArch.style.display = "none";
  });
  tabArch.addEventListener("click", () => {
    tabArch.classList.add("active");
    tabGuide.classList.remove("active");
    paneArch.style.display = "block";
    paneGuide.style.display = "none";
  });

  btnMetrics.addEventListener("click", async () => {
    infoModal.classList.remove("open");
    metricsModal.classList.add("open");
    await renderMetricsReport();
  });
  btnCloseMetrics.addEventListener("click", () => metricsModal.classList.remove("open"));
  metricsModal.addEventListener("click", (e) => {
    if (e.target === metricsModal) metricsModal.classList.remove("open");
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      infoModal.classList.remove("open");
      metricsModal.classList.remove("open");
    }
  });
}

function setupInteractions() {
  const tooltip = document.getElementById("hover-tooltip");

  function handleHover(e) {
    const feat = e.features?.[0];
    if (!feat || !flowData) {
      tooltip.style.display = "none";
      map.getCanvas().style.cursor = "";
      return;
    }
    map.getCanvas().style.cursor = "pointer";
    const p = feat.properties;
    const st = flowData.stations[String(p.station_id)];
    if (!st) return;

    const qVal = p.is_measured ? st.q : ((Number(p.area_km2) * st.r) / 1000).toFixed(1);
    const label = p.basin ? `${p.basin} · ${st.name}` : st.name;
    tooltip.innerHTML = `<strong>${label}</strong><br/>${qVal} m³/s · p${st.pct} (${p.is_measured ? "Measured" : "Est."})`;
    tooltip.style.left = `${e.originalEvent.clientX + 14}px`;
    tooltip.style.top = `${e.originalEvent.clientY + 14}px`;
    tooltip.style.display = "block";
  }

  map.on("mousemove", "rivers-base", handleHover);
  map.on("mousemove", "stations-circle", handleHover);
  map.on("mouseleave", "rivers-base", () => {
    tooltip.style.display = "none";
    map.getCanvas().style.cursor = "";
  });
  map.on("mouseleave", "stations-circle", () => {
    tooltip.style.display = "none";
    map.getCanvas().style.cursor = "";
  });

  map.on("click", async (e) => {
    const feats = map.queryRenderedFeatures(e.point, {
      layers: ["stations-circle", "rivers-base"],
    });
    if (!feats.length) {
      document.getElementById("detail-drawer").classList.remove("open");
      return;
    }
    const p = feats[0].properties;
    await openStationDrawer(String(p.station_id), Number(p.area_km2), Boolean(p.is_measured), p.basin);
  });
}

async function openStationDrawer(pid, reachAreaKm2, isMeasured, reachBasin) {
  const st = flowData?.stations?.[pid];
  if (!st) return;

  if (!seriesCache) {
    const r = await fetch(`${FLOWS_BASE}/station_series.json`);
    seriesCache = await r.json();
  }
  const series = seriesCache[pid] || [];
  const qDisplay = isMeasured ? st.q : Number(((reachAreaKm2 * st.r) / 1000).toFixed(1));
  const trendSign = st.tr > 0 ? "+" : "";
  const badgeCls = isMeasured ? "measured" : "estimated";
  const badgeTxt = isMeasured ? "SYKE Gauging Station" : "Catchment-Scaled Reach";

  const drawer = document.getElementById("detail-drawer");
  drawer.innerHTML = `
    <div class="drawer-top">
      <div>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
        <div class="drawer-title">${st.name}</div>
        <div class="drawer-sub">${reachBasin || st.basin} · ${st.mun || "Finland"} · Obs ${st.t}</div>
      </div>
      <button class="icon-btn" id="close-drawer" aria-label="Close">×</button>
    </div>

    <div class="stat-row">
      <div class="stat-cell">
        <div class="stat-val">${qDisplay} <small style="font-weight:400;font-size:11px;">m³/s</small></div>
        <div class="stat-lbl">${isMeasured ? "Measured Flow" : "Est. Reach Flow"}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-val">p${st.pct}</div>
        <div class="stat-lbl">15y Percentile</div>
      </div>
      <div class="stat-cell">
        <div class="stat-val">${trendSign}${st.tr}%</div>
        <div class="stat-lbl">7-Day Trend</div>
      </div>
    </div>

    <div class="chart-caption">
      <span>30-Day Station Discharge (${st.name}: ${st.q} m³/s)</span>
      <span>Median: ${st.p50} m³/s</span>
    </div>
    ${renderHydrographSVG(series, st.p10, st.p50, st.p90)}
    <div class="chart-caption" style="margin-top:6px;">
      <span>Reach area: ${Math.round(reachAreaKm2 || st.area).toLocaleString()} km²</span>
      <span>p10: ${st.p10} · p90: ${st.p90} m³/s</span>
    </div>
  `;
  drawer.classList.add("open");
  document.getElementById("close-drawer").onclick = () => drawer.classList.remove("open");
}

function renderHydrographSVG(series, p10, p50, p90) {
  if (!series.length) return "<div class='drawer-sub'>No 30-day series available</div>";
  const w = 330;
  const h = 92;
  const vals = series.map((d) => d[1]);
  const lo = Math.min(...vals, p10) * 0.92;
  const hi = Math.max(...vals, p90) * 1.08 || 1;
  const span = Math.max(hi - lo, 0.1);
  const y = (v) => h - 10 - ((v - lo) / span) * (h - 20);
  const x = (i) => (i / Math.max(vals.length - 1, 1)) * w;

  const linePath = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const yP50 = y(p50).toFixed(1);
  const yBandTop = y(p90).toFixed(1);
  const yBandBot = y(p10).toFixed(1);
  const bandH = Math.max(Number(yBandBot) - Number(yBandTop), 1).toFixed(1);

  return `
    <svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="hydro-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.38" />
          <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      <rect x="0" y="${yBandTop}" width="${w}" height="${bandH}" fill="rgba(148,163,184,0.10)" />
      <line x1="0" y1="${yP50}" x2="${w}" y2="${yP50}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,3" />
      <path d="${areaPath}" fill="url(#hydro-fill)" />
      <path d="${linePath}" fill="none" stroke="#38bdf8" stroke-width="2.2" />
    </svg>
  `;
}

function setupSearch() {
  const input = document.getElementById("station-search");
  const box = document.getElementById("search-results");

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !flowData) {
      box.classList.remove("open");
      return;
    }
    const matches = Object.entries(flowData.stations)
      .filter(
        ([, s]) =>
          s.name.toLowerCase().includes(q) ||
          (s.basin && s.basin.toLowerCase().includes(q)) ||
          (s.mun && s.mun.toLowerCase().includes(q))
      )
      .slice(0, 10);

    if (!matches.length) {
      box.classList.remove("open");
      return;
    }
    box.innerHTML = matches
      .map(
        ([pid, s]) => `
        <div class="search-item" data-pid="${pid}">
          <span><strong>${s.name}</strong> · <small style="color:#94a3b8">${s.basin}</small></span>
          <span>${s.q} m³/s</span>
        </div>`
      )
      .join("");
    box.classList.add("open");

    box.querySelectorAll(".search-item").forEach((el) => {
      el.addEventListener("click", () => {
        const pid = el.dataset.pid;
        const st = flowData.stations[pid];
        box.classList.remove("open");
        input.value = st.name;
        map.flyTo({ center: [st.lon, st.lat], zoom: 9.2, duration: 1200 });
        openStationDrawer(pid, st.area, true, st.basin);
      });
    });
  });
}

// --- Live Metrics & Reporting Dashboard ---

function pctBadgeStyle(pct) {
  if (pct <= 15) return "background:rgba(245,158,11,0.18);color:#fbbf24;";
  if (pct <= 35) return "background:rgba(234,179,8,0.16);color:#fde047;";
  if (pct <= 65) return "background:rgba(34,211,238,0.16);color:#22d3ee;";
  if (pct <= 85) return "background:rgba(59,130,246,0.2);color:#93c5fd;";
  return "background:rgba(192,132,252,0.22);color:#d8b4fe;";
}

function regimeLabel(pct) {
  if (pct <= 15) return "Dry / Low";
  if (pct <= 35) return "Below Normal";
  if (pct <= 65) return "Normal";
  if (pct <= 85) return "Above Normal";
  return "High / Flood";
}

async function renderMetricsReport() {
  const container = document.getElementById("metrics-body");
  if (!flowData) {
    container.innerHTML = "<p>Waiting for live SYKE station data to finish loading…</p>";
    return;
  }

  if (!seriesCache) {
    container.innerHTML = "<p>Loading 30-day national discharge time series…</p>";
    const r = await fetch(`${FLOWS_BASE}/station_series.json`);
    seriesCache = await r.json();
  }

  const entries = Object.entries(flowData.stations).map(([pid, s]) => ({ pid, ...s }));
  const total = entries.length || 1;
  const sum = flowData.summary || {};
  const medianPct = sum.median_pct ?? 50;

  // 1. Percentile distribution buckets
  const buckets = [
    { label: "High / Flood (>p85)", color: "#c084fc", count: entries.filter((s) => s.pct > 85).length },
    { label: "Above Normal (p66–85)", color: "#3b82f6", count: entries.filter((s) => s.pct > 65 && s.pct <= 85).length },
    { label: "Normal (p36–65)", color: "#22d3ee", count: entries.filter((s) => s.pct > 35 && s.pct <= 65).length },
    { label: "Below Normal (p16–35)", color: "#eab308", count: entries.filter((s) => s.pct > 15 && s.pct <= 35).length },
    { label: "Dry / Low (≤p15)", color: "#f59e0b", count: entries.filter((s) => s.pct <= 15).length },
  ];
  const maxBucket = Math.max(...buckets.map((b) => b.count), 1);

  // 2. 30-day national daily aggregate gauged flow vs sum of station medians
  const dailySums = new Map();
  const dailyCounts = new Map();
  for (const s of entries) {
    const pts = seriesCache[s.pid] || [];
    for (const [dt, q] of pts) {
      dailySums.set(dt, (dailySums.get(dt) || 0) + q);
      dailyCounts.set(dt, (dailyCounts.get(dt) || 0) + 1);
    }
  }
  // Keep days where at least 60% of active stations reported (avoids partial latest-day dip)
  const minReporting = Math.floor(total * 0.6);
  const aggSeries = [...dailySums.entries()]
    .filter(([dt]) => (dailyCounts.get(dt) || 0) >= minReporting)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-30);

  const totalMedianQ = entries.reduce((acc, s) => acc + (Number(s.p50) || 0), 0);
  const latestAggQ = aggSeries.length ? aggSeries[aggSeries.length - 1][1] : sum.total_station_q || 0;
  const vsMedianRatio = totalMedianQ > 0 ? Math.round((latestAggQ / totalMedianQ) * 100) : 100;

  // 3. Aggregate by major Finnish river basin (top 8 by peak discharge)
  const basinMap = new Map();
  for (const s of entries) {
    if (!s.basin) continue;
    const cur = basinMap.get(s.basin) || { basin: s.basin, maxQ: 0, pctSum: 0, rSum: 0, n: 0 };
    cur.maxQ = Math.max(cur.maxQ, s.q);
    cur.pctSum += s.pct;
    cur.rSum += s.r;
    cur.n += 1;
    basinMap.set(s.basin, cur);
  }
  const topBasins = [...basinMap.values()]
    .sort((a, b) => b.maxQ - a.maxQ)
    .slice(0, 8);
  const maxBasinQ = Math.max(...topBasins.map((b) => b.maxQ), 1);

  // 4. Station leaderboards (Top volume & Fastest 7-day surge on meaningful rivers >= 5 m³/s)
  const topVolume = [...entries].sort((a, b) => b.q - a.q).slice(0, 7);
  const topSurging = entries
    .filter((s) => s.q >= 5)
    .sort((a, b) => b.tr - a.tr)
    .slice(0, 7);
  const risingCount = entries.filter((s) => s.tr >= 20 && s.q >= 2).length;

  container.innerHTML = `
    <div class="metrics-kpis">
      <div class="m-kpi">
        <div class="m-kpi-val">${entries.length}</div>
        <div class="m-kpi-sub">Active SYKE Stations (${sum.latest_obs_date || "Live"})</div>
      </div>
      <div class="m-kpi">
        <div class="m-kpi-val">p${medianPct}</div>
        <div class="m-kpi-sub">National Median (${regimeLabel(medianPct)})</div>
      </div>
      <div class="m-kpi">
        <div class="m-kpi-val">${vsMedianRatio}%</div>
        <div class="m-kpi-sub">Total Flow vs. 15y Median</div>
      </div>
      <div class="m-kpi">
        <div class="m-kpi-val" style="color:#c084fc">${buckets[0].count} <small style="font-size:12px;font-weight:500;">(${Math.round((buckets[0].count / total) * 100)}%)</small></div>
        <div class="m-kpi-sub">High / Flood Stations (&gt;p85)</div>
      </div>
      <div class="m-kpi">
        <div class="m-kpi-val" style="color:#38bdf8">${risingCount}</div>
        <div class="m-kpi-sub">Surging Rivers (7d &ge; +20%)</div>
      </div>
    </div>

    <div class="metrics-grid-2">
      <div class="m-panel">
        <div class="m-panel-title">30-Day National Aggregate Gauged Flow</div>
        <div class="m-panel-sub">Sum of daily discharge across reporting SYKE stations vs. 15-year median baseline (${Math.round(totalMedianQ).toLocaleString()} m³/s dashed)</div>
        ${renderNationalTrendSVG(aggSeries, totalMedianQ)}
      </div>

      <div class="m-panel">
        <div class="m-panel-title">Flow Regime Distribution</div>
        <div class="m-panel-sub">Share of Finland's ${entries.length} active stations by historical percentile</div>
        <div class="dist-rows">
          ${buckets
            .map(
              (b) => `
            <div class="bar-row">
              <span>${b.label}</span>
              <div class="bar-track">
                <div class="bar-fill" style="width:${((b.count / maxBucket) * 100).toFixed(1)}%;background:${b.color};"></div>
              </div>
              <span class="bar-num">${b.count} (${Math.round((b.count / total) * 100)}%)</span>
            </div>`
            )
            .join("")}
        </div>
      </div>
    </div>

    <div class="m-panel" style="margin-bottom:16px;">
      <div class="m-panel-title">Major River Basins Snapshot</div>
      <div class="m-panel-sub">Peak gauged discharge (m³/s) and mean basin flow percentile across Finland's largest watersheds</div>
      <div class="basin-rows">
        ${topBasins
          .map((b) => {
            const avgPct = Math.round(b.pctSum / b.n);
            return `
            <div class="bar-row" style="grid-template-columns: 145px 1fr 135px;">
              <span><strong>${b.basin}</strong> <small style="color:#94a3b8">(${b.n})</small></span>
              <div class="bar-track">
                <div class="bar-fill" style="width:${((b.maxQ / maxBasinQ) * 100).toFixed(1)}%;background:#38bdf8;"></div>
              </div>
              <span class="bar-num">${b.maxQ.toFixed(0)} m³/s · <span class="pct-pill" style="${pctBadgeStyle(avgPct)}">p${avgPct}</span></span>
            </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="metrics-grid-2" style="grid-template-columns: 1fr 1fr; margin-bottom: 0;">
      <div class="m-panel">
        <div class="m-panel-title">Highest Discharge Stations</div>
        <div class="m-panel-sub">Largest measured river flows right now (click to inspect on map)</div>
        <table class="m-table">
          <thead>
            <tr><th>Station</th><th>Basin</th><th>Flow</th><th>Pct</th></tr>
          </thead>
          <tbody>
            ${topVolume
              .map(
                (s) => `
              <tr class="clickable-row" data-pid="${s.pid}">
                <td><strong>${s.name}</strong></td>
                <td style="color:#94a3b8">${s.basin}</td>
                <td>${s.q.toFixed(1)} m³/s</td>
                <td><span class="pct-pill" style="${pctBadgeStyle(s.pct)}">p${s.pct}</span></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>

      <div class="m-panel">
        <div class="m-panel-title">Fastest Rising Rivers (7-Day Surge)</div>
        <div class="m-panel-sub">Biggest 7-day percentage increases among rivers &ge; 5 m³/s (click to inspect)</div>
        <table class="m-table">
          <thead>
            <tr><th>Station</th><th>Basin</th><th>Flow</th><th>7d Trend</th></tr>
          </thead>
          <tbody>
            ${topSurging
              .map(
                (s) => `
              <tr class="clickable-row" data-pid="${s.pid}">
                <td><strong>${s.name}</strong></td>
                <td style="color:#94a3b8">${s.basin}</td>
                <td>${s.q.toFixed(1)} m³/s</td>
                <td style="color:${s.tr >= 0 ? "#c084fc" : "#94a3b8"};font-weight:600;">${s.tr > 0 ? "+" : ""}${s.tr}%</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  container.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => {
      const pid = row.dataset.pid;
      const st = flowData.stations[pid];
      if (!st) return;
      document.getElementById("metrics-modal").classList.remove("open");
      map.flyTo({ center: [st.lon, st.lat], zoom: 9.2, duration: 1200 });
      openStationDrawer(pid, st.area, true, st.basin);
    });
  });
}

function renderNationalTrendSVG(aggSeries, baselineQ) {
  if (!aggSeries.length) return "<div class='m-panel-sub'>No 30-day series available</div>";
  const w = 460;
  const h = 135;
  const vals = aggSeries.map((d) => d[1]);
  const lo = Math.min(...vals, baselineQ) * 0.88;
  const hi = Math.max(...vals, baselineQ) * 1.08 || 1;
  const span = Math.max(hi - lo, 1);
  const y = (v) => h - 22 - ((v - lo) / span) * (h - 34);
  const x = (i) => (i / Math.max(vals.length - 1, 1)) * w;

  const line = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h - 18} L0,${h - 18} Z`;
  const yBase = y(baselineQ).toFixed(1);
  const firstDate = aggSeries[0][0];
  const lastDate = aggSeries[aggSeries.length - 1][0];
  const lastVal = Math.round(vals[vals.length - 1]).toLocaleString();

  return `
    <svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="nat-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.4" />
          <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      <line x1="0" y1="${yBase}" x2="${w}" y2="${yBase}" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="5,4" />
      <path d="${area}" fill="url(#nat-grad)" />
      <path d="${line}" fill="none" stroke="#38bdf8" stroke-width="2.4" />
      <text x="2" y="${h - 4}" fill="#94a3b8" font-size="10.5">${firstDate}</text>
      <text x="${w - 2}" y="${h - 4}" fill="#e2e8f0" font-size="10.5" text-anchor="end">${lastDate}: ${lastVal} m³/s</text>
    </svg>
  `;
}
