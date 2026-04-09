import { AdsbLayer } from "./adsb";
import "./styles.css";
import {
  buildManifestQuery,
  fetchShardCandidates,
  getDuckDB,
  MANIFEST_URL,
  mapWithConcurrency,
  resolveShardUrl,
  sqlString,
} from "./db";
import { exportGeoParquet } from "./export";
import {
  fetchGeocode,
  flyToHit,
  getGeocodeReqId,
  getGeocodeTimer,
  nextGeocodeReqId,
  renderGeocodeResults,
  setGeocodeTimer,
  tryParseLatLng,
} from "./geocoder";
import { GlobeMap } from "./map";
import { AOI_PRESETS, INTERESTING_POINTS } from "./presets";
import { wireTutorial } from "./tutorial";
import type {
  AoiEntry,
  BBox,
  CandidateRow,
  CombineMethod,
  ManifestRow,
  NegativePoint,
  PositiveMatch,
  PositivePoint,
  RankedRow,
  ViewMode,
} from "./types";
import {
  centroid,
  containsPoint,
  distanceSquared,
  formatLatLng,
  normalizeBBox,
  normalizeEmbedding,
  pointInPolygon,
} from "./util";

const DEFAULT_TOP_K = 50;
const MAX_TOP_K = 100;

type AppState = {
  bboxes: AoiEntry[];
  nextAoiId: number;
  regionRows: Map<number, CandidateRow[]>;
  regionShardCounts: Map<number, number>;
  status: string;
  candidateRows: CandidateRow[];
  positivePoints: PositivePoint[];
  negativePoints: NegativePoint[];
  positiveMatches: PositiveMatch[];
  baseResults: RankedRow[];
  results: RankedRow[];
  outlierResults: RankedRow[];
  outlierComputed: boolean;
  surpriseResults: RankedRow[];
  surpriseComputed: boolean;
  gradientResults: RankedRow[];
  topK: number;
  viewMode: ViewMode;
  threshold: number;
  overlayVisible: boolean;
  loading: boolean;
  combineMethod: CombineMethod;
  invertSearch: boolean;
};

const state: AppState = {
  bboxes: [],
  nextAoiId: 1,
  regionRows: new Map(),
  regionShardCounts: new Map(),
  status:
    "Spin the globe. Zoom. Shift-drag or hit Draw region to define an AOI.",
  candidateRows: [],
  positivePoints: [],
  negativePoints: [],
  positiveMatches: [],
  baseResults: [],
  results: [],
  outlierResults: [],
  outlierComputed: false,
  surpriseResults: [],
  surpriseComputed: false,
  gradientResults: [],
  topK: DEFAULT_TOP_K,
  viewMode: "topk",
  threshold: Infinity,
  overlayVisible: true,
  loading: false,
  combineMethod: "mean",
  invertSearch: false,
};

let globe: GlobeMap;
let scoringWorker: Worker | null = null;
let scoringWorkerReady = false;
let scoringRequestId = 0;
let latestScoreRunId = 0;
const regionLoadRunIds = new Map<number, number>();

let outlierComputing = false;
let surpriseComputing = false;
let gradientComputing = false;
let outlierEpoch = 0;
let surpriseEpoch = 0;

// Render fingerprints — skip DOM rebuild when data hasn't changed
let lastPositiveListKey = "";
let lastNegativeListKey = "";
let lastResultListKey = "";

function resetComputeState(): void {
  outlierComputing = false;
  surpriseComputing = false;
  gradientComputing = false;
}

function isInsideAnyAoi(lat: number, lng: number): boolean {
  return state.bboxes.some((e) =>
    e.polygon
      ? pointInPolygon(e.polygon, lat, lng)
      : containsPoint(e.bbox, lat, lng),
  );
}

function isMobileViewport(): boolean {
  return window.innerWidth <= 600;
}

function syncPolyDoneBtn(): void {
  const btn = document.querySelector<HTMLButtonElement>("#poly-done-btn");
  if (!btn) return;
  const show =
    globe.isArmed() &&
    globe.getDrawMode() === "polygon" &&
    globe.getPolyVertexCount() >= 3;
  btn.hidden = !show;
}

/* ------------------------------------------------------------------ UI shell */

function renderShell(): void {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("App root missing");
  document.title = "terrabit \u2014 binary earth embedding retrieval";
  app.innerHTML = `
    <div class="viewport">
      <div id="map" class="map-canvas"></div>

      <header class="hud-brand">
        <div class="brand-mark" aria-hidden="true">
          <span class="brand-ring"></span>
          <span class="brand-ring brand-ring-2"></span>
          <span class="brand-dot"></span>
        </div>
        <div class="brand-text">
          <h1>terrabit</h1>
          <p>binary earth embedding retrieval</p>
          <p class="brand-attribution">Created by <a href="https://isaac.earth" target="_blank" rel="noopener noreferrer">Isaac Corley</a></p>
        </div>
      </header>

      <div class="hud-search" id="search-wrap">
        <div class="search-bar">
          <svg class="search-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            id="search-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search a place \u2014 country, city, park, coordinates\u2026"
          />
          <span id="search-spinner" class="search-spinner" aria-hidden="true"></span>
          <kbd class="search-kbd">/</kbd>
        </div>
        <ul id="search-results" class="search-results" role="listbox"></ul>
      </div>

      <div class="hud-status" id="status-pill">
        <span class="status-led"></span>
        <span id="status-text">${state.status}</span>
      </div>

      <section class="hud-panel hud-panel-left" id="query-panel">
        <header class="panel-head">
          <span class="panel-kicker">Query</span>
        </header>
        <div class="draw-row">
          <div class="draw-mode-seg" title="Shape mode">
            <button id="draw-mode-rect" class="draw-mode-btn" type="button" aria-label="Draw box region" title="Draw a box region">Draw Box</button>
            <button id="draw-mode-poly" class="draw-mode-btn" type="button" aria-label="Polygon mode" title="Polygon \u2014 click to add vertices, double-click to close">Draw Poly</button>
            <button id="poly-done-btn" class="draw-mode-btn poly-done-btn" type="button" hidden aria-label="Finish polygon">Done \u2713</button>
          </div>
          <button id="zoom-region-btn" class="icon-btn" type="button" hidden title="Zoom to region(s)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 2H2v4"/><path d="M14 6V2h-4"/><path d="M2 10v4h4"/><path d="M10 14h4v-4"/></svg>
          </button>
        </div>
        <div id="active-regions" class="active-regions"></div>

        <div class="panel-split">
          <div class="sub-card">
            <header class="sub-head">
              <div>
                <span class="panel-kicker">Exemplars</span>
              </div>
              <div class="sub-head-actions">
                <button id="invert-toggle" class="icon-btn" type="button" title="Invert search (find opposites)" aria-label="Invert search">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="8" r="6"/><line x1="3" y1="3" x2="13" y2="13"/></svg>
                </button>
                <select id="combine-method" class="combine-select" title="Combine method">
                  <option value="mean">MEAN</option>
                  <option value="and">AND</option>
                  <option value="or">OR</option>
                  <option value="xor">XOR</option>
                </select>
                <span id="exemplar-count" class="count-badge">0</span>
                <button id="clear-points-btn" class="icon-btn" type="button" title="Clear points" aria-label="Clear points">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                </button>
              </div>
            </header>
            <ol id="positive-list" class="exemplar-list"></ol>
            <div id="negative-section" hidden>
              <div class="neg-header">
                <span class="panel-kicker neg-kicker">Negatives</span>
                <button id="clear-negatives-btn" class="icon-btn" type="button" title="Clear negatives" aria-label="Clear negatives">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                </button>
              </div>
              <ol id="negative-list" class="exemplar-list negative-list"></ol>
            </div>
          </div>

          <div class="sub-card sub-card-retrieval">
            <header class="sub-head sub-head-stack">
              <div>
                <span class="panel-kicker">Retrieval</span>
              </div>
              <div class="sub-head-actions">
                <span id="result-count" class="result-summary"></span>
                <button class="icon-btn" type="button" aria-label="View mode help" data-help="retrieval">
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.1a2 2 0 0 1 3.6 1.2c0 1.5-1.8 1.8-1.8 3"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>
                </button>
                <button id="overlay-toggle" class="icon-btn is-on" type="button" title="Toggle map overlay" aria-label="Toggle map overlay">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M1 8l7-5 7 5-7 5z"/><path d="M1 11l7 5 7-5" opacity=".4"/></svg>
                </button>
              </div>
            </header>

            <div class="view-toggle" role="tablist" aria-label="Result view">
              <button data-view="topk" class="view-tab is-active" type="button" role="tab" title="Top-K \u2014 Ranked list of most similar patches" aria-label="Top-K ranked list">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="3" width="12" height="3" rx="0.6"/><rect x="2" y="7" width="9" height="3" rx="0.6"/><rect x="2" y="11" width="5" height="3" rx="0.6"/></svg>
                <span class="view-label">Top-K</span>
              </button>
              <button data-view="heatmap" class="view-tab" type="button" role="tab" title="Heatmap \u2014 Continuous similarity surface across all patches" aria-label="Heatmap of all scored tiles">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="2" width="4" height="4"/><rect x="6" y="2" width="4" height="4"/><rect x="10" y="2" width="4" height="4"/><rect x="2" y="6" width="4" height="4"/><rect x="6" y="6" width="4" height="4"/><rect x="10" y="6" width="4" height="4"/><rect x="2" y="10" width="4" height="4"/><rect x="6" y="10" width="4" height="4"/><rect x="10" y="10" width="4" height="4"/></svg>
                <span class="view-label">Heat</span>
              </button>
              <button data-view="threshold" class="view-tab" type="button" role="tab" title="Cutoff \u2014 Show all patches within a Hamming distance threshold" aria-label="Distance cutoff">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="10" width="2" height="4"/><rect x="5" y="6" width="2" height="8"/><rect x="8" y="3" width="2" height="11"/><rect x="11" y="8" width="2" height="6"/><line x1="1" y1="7" x2="15" y2="7" stroke-dasharray="2 1.5"/></svg>
                <span class="view-label">Cutoff</span>
              </button>
              <button data-view="outlier" class="view-tab" type="button" role="tab" title="Outlier \u2014 Find the most unique and unusual patches in the region" aria-label="Most unique patches">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="8" r="2"/><circle cx="4" cy="6" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="13" cy="11" r="1.2"/><circle cx="3" cy="12" r="1.2"/></svg>
                <span class="view-label">Outlier</span>
              </button>
              <button data-view="surprise" class="view-tab" type="button" role="tab" title="Surprise \u2014 Patches that look different from their geographic neighbors" aria-label="Spatial surprise">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 2v7"/><circle cx="8" cy="12.5" r="1.5"/></svg>
                <span class="view-label">Surprise</span>
              </button>
              <button data-view="gradient" class="view-tab" type="button" role="tab" title="Edge \u2014 Detect boundaries where similarity scores change sharply" aria-label="Similarity gradient edge detection">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 14L8 2l6 12"/><line x1="4" y1="10" x2="12" y2="10"/></svg>
                <span class="view-label">Edge</span>
              </button>
            </div>

            <div id="topk-control" class="slider-row" hidden>
              <label class="slider">
                <span>Top-k <strong id="topk-value">${DEFAULT_TOP_K}</strong></span>
                <input id="topk-slider" type="range" min="1" max="${MAX_TOP_K}" value="${DEFAULT_TOP_K}" />
              </label>
            </div>

            <div id="heatmap-legend" class="heatmap-legend" hidden>
              <div class="legend-gradient"></div>
              <div class="legend-labels"><span>Distant</span><span>Similar</span></div>
            </div>
            <div id="outlier-legend" class="heatmap-legend" hidden>
              <div class="legend-gradient legend-gradient-outlier"></div>
              <div class="legend-labels"><span>Common</span><span>Unique</span></div>
            </div>
            <div id="surprise-legend" class="heatmap-legend" hidden>
              <div class="legend-gradient legend-gradient-outlier"></div>
              <div class="legend-labels"><span>Expected</span><span>Surprising</span></div>
            </div>
            <div id="gradient-legend" class="heatmap-legend" hidden>
              <div class="legend-gradient legend-gradient-outlier"></div>
              <div class="legend-labels"><span>Uniform</span><span>Boundary</span></div>
            </div>
            <div id="gradient-msg" class="gradient-msg" hidden>
              <span class="hint">Add exemplars to use Edge view.</span>
            </div>

            <div id="threshold-control" class="threshold-control" hidden>
              <div id="histogram-wrap" class="histogram-wrap"></div>
              <label class="slider">
                <span>Distance \u2264 <strong id="threshold-value">0</strong> \u00b7 <strong id="threshold-count">0</strong> patches</span>
                <input id="threshold-slider" type="range" min="0" max="100" value="50" step="0.1" />
              </label>
            </div>

            <ol id="result-list" class="result-list"></ol>
            <div class="action-row">
              <button id="export-btn" class="btn btn-sm btn-ghost action-btn" type="button" hidden>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 11v3h12v-3"/><path d="M8 2v8"/><path d="M5 7l3 3 3-3"/></svg>
                <span>Export</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      <nav class="hud-panel hud-panel-right hud-aoi-nav" id="aoi-nav">
        <header class="panel-head panel-head-row">
          <span class="panel-kicker">Explore</span>
          <button class="icon-btn" type="button" aria-label="About Explore" data-help="explore">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.1a2 2 0 0 1 3.6 1.2c0 1.5-1.8 1.8-1.8 3"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>
          </button>
        </header>
        <ul id="aoi-list" class="aoi-list"></ul>
        <div class="ip-divider"></div>
        <section class="ip-section">
          <header class="ip-head">
            <span class="panel-kicker">Discoveries</span>
            <button class="icon-btn" type="button" aria-label="About Discoveries" data-help="discoveries">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.1a2 2 0 0 1 3.6 1.2c0 1.5-1.8 1.8-1.8 3"/><circle cx="8" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>
            </button>
          </header>
          <ul id="ip-list" class="ip-list"></ul>
        </section>
      </nav>

    </div>
    <button id="tutorial-trigger" class="tutorial-trigger" type="button" aria-label="Open tutorial" title="Help &amp; tutorial">?</button>
  `;
}

function els() {
  return {
    status: document.querySelector<HTMLElement>("#status-text"),
    statusPill: document.querySelector<HTMLElement>("#status-pill"),
    drawModeRect: document.querySelector<HTMLButtonElement>("#draw-mode-rect"),
    drawModePoly: document.querySelector<HTMLButtonElement>("#draw-mode-poly"),
    polyDoneBtn: document.querySelector<HTMLButtonElement>("#poly-done-btn"),
    zoomRegionBtn:
      document.querySelector<HTMLButtonElement>("#zoom-region-btn"),
    activeRegions: document.querySelector<HTMLDivElement>("#active-regions"),
    positiveList: document.querySelector<HTMLOListElement>("#positive-list"),
    negativeList: document.querySelector<HTMLOListElement>("#negative-list"),
    negativeSection: document.querySelector<HTMLElement>("#negative-section"),
    clearNegativesBtn: document.querySelector<HTMLButtonElement>(
      "#clear-negatives-btn",
    ),
    exemplarCount: document.querySelector<HTMLElement>("#exemplar-count"),
    invertToggle: document.querySelector<HTMLButtonElement>("#invert-toggle"),
    combineSelect: document.querySelector<HTMLSelectElement>("#combine-method"),
    topkSlider: document.querySelector<HTMLInputElement>("#topk-slider"),
    topkValue: document.querySelector<HTMLElement>("#topk-value"),
    topkControl: document.querySelector<HTMLElement>("#topk-control"),
    viewTabs: document.querySelectorAll<HTMLButtonElement>(
      ".view-tab[data-view]",
    ),
    heatmapLegend: document.querySelector<HTMLElement>("#heatmap-legend"),
    outlierLegend: document.querySelector<HTMLElement>("#outlier-legend"),
    surpriseLegend: document.querySelector<HTMLElement>("#surprise-legend"),
    gradientLegend: document.querySelector<HTMLElement>("#gradient-legend"),
    gradientMsg: document.querySelector<HTMLElement>("#gradient-msg"),
    thresholdControl: document.querySelector<HTMLElement>("#threshold-control"),
    thresholdSlider:
      document.querySelector<HTMLInputElement>("#threshold-slider"),
    thresholdValue: document.querySelector<HTMLElement>("#threshold-value"),
    thresholdCount: document.querySelector<HTMLElement>("#threshold-count"),
    histogramWrap: document.querySelector<HTMLElement>("#histogram-wrap"),
    overlayToggle: document.querySelector<HTMLButtonElement>("#overlay-toggle"),
    clearPointsBtn:
      document.querySelector<HTMLButtonElement>("#clear-points-btn"),
    resultCount: document.querySelector<HTMLElement>("#result-count"),
    resultList: document.querySelector<HTMLOListElement>("#result-list"),
    exportBtn: document.querySelector<HTMLButtonElement>("#export-btn"),
    searchWrap: document.querySelector<HTMLElement>("#search-wrap"),
    searchInput: document.querySelector<HTMLInputElement>("#search-input"),
    searchResults: document.querySelector<HTMLUListElement>("#search-results"),
    searchSpinner: document.querySelector<HTMLElement>("#search-spinner"),
    aoiList: document.querySelector<HTMLUListElement>("#aoi-list"),
  };
}

/* --------------------------------------------------------------- Preset rendering */

function renderAoiPresets(): void {
  const e = els();
  if (!e.aoiList) return;
  e.aoiList.innerHTML = AOI_PRESETS.map(
    (aoi, i) => `
    <li class="aoi-item" style="--i:${i}">
      <button type="button" data-aoi="${i}">
        <span class="aoi-name">${aoi.name}</span>
        <span class="aoi-tag">${aoi.tag}</span>
      </button>
    </li>`,
  ).join("");
  e.aoiList
    .querySelectorAll<HTMLButtonElement>("button[data-aoi]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const aoi = AOI_PRESETS[Number(btn.dataset.aoi)];
        globe.fitBounds(aoi.bbox, { padding: 60, maxZoom: 11 });
        setStatus(`${aoi.name} \u2014 shift-drag to draw a region.`);
      });
    });
}

function renderInterestingPoints(): void {
  const list = document.querySelector<HTMLUListElement>("#ip-list");
  if (!list) return;
  list.innerHTML = INTERESTING_POINTS.map(
    (pt, i) => `
    <li class="ip-item" data-category="${pt.category}" style="--i:${i}">
      <button type="button" data-ip="${i}">
        <span class="ip-name">${pt.name}</span>
        <span class="ip-tag">${pt.tag}</span>
      </button>
    </li>`,
  ).join("");
  list.querySelectorAll<HTMLButtonElement>("button[data-ip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pt = INTERESTING_POINTS[Number(btn.dataset.ip)];
      globe.fitBounds(pt.bbox, { padding: 60, maxZoom: 11 });
      setStatus(`${pt.name} \u2014 shift-drag to draw a region.`);
    });
  });
}

/* --------------------------------------------------------------- Status & helpers */

function setStatus(message: string): void {
  state.status = message;
  updateView();
}

function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function syncSliderFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const val = Number(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--v", `${pct}%`);
}

function renderHistogram(scores: number[], threshold: number): string {
  if (!scores.length) return "";
  const bins = 32;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const binWidth = range / bins;
  const counts = new Array(bins).fill(0) as number[];
  for (const s of scores) {
    const bin = Math.min(Math.floor((s - min) / binWidth), bins - 1);
    counts[bin]++;
  }
  const maxCount = Math.max(...counts);
  const w = 240;
  const h = 36;
  const bw = w / bins;
  const bars = counts
    .map((count, i) => {
      const binMid = min + (i + 0.5) * binWidth;
      const barH = maxCount > 0 ? (count / maxCount) * h : 0;
      const x = i * bw;
      const y = h - barH;
      const fill =
        binMid <= threshold ? "var(--accent)" : "rgba(243,236,216,0.1)";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 0.5).toFixed(1)}" height="${barH.toFixed(1)}" fill="${fill}" rx="1"/>`;
    })
    .join("");
  return `<svg class="histogram-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
}

/* --------------------------------------------------------------- Update view */

function updateView(): void {
  const e = els();
  if (!e.status || !e.positiveList || !e.resultList) return;

  e.status.textContent = state.status;
  e.statusPill?.classList.toggle("is-busy", state.loading);

  const armed = globe?.isArmed() ?? false;
  const polyArmed = armed && globe?.getDrawMode() === "polygon";
  const rectArmed = armed && !polyArmed;
  e.drawModeRect?.classList.toggle("is-armed", rectArmed);
  e.drawModePoly?.classList.toggle("is-armed", polyArmed);

  if (e.zoomRegionBtn) e.zoomRegionBtn.hidden = state.bboxes.length === 0;

  if (e.activeRegions) {
    const regKey = state.bboxes.map((a) => a.id).join(",");
    if (e.activeRegions.dataset.key !== regKey) {
      e.activeRegions.dataset.key = regKey;
      e.activeRegions.innerHTML = "";
      if (state.bboxes.length) {
        for (const entry of state.bboxes) {
          const chip = document.createElement("div");
          chip.className = "aoi-chip";
          chip.innerHTML = `<span class="aoi-chip-label">AOI ${entry.id}</span><button class="aoi-chip-remove" data-aoi-id="${entry.id}" title="Remove region" aria-label="Remove AOI ${entry.id}">\u00d7</button>`;
          e.activeRegions.appendChild(chip);
        }
        const clearAll = document.createElement("button");
        clearAll.className = "clear-all-btn";
        clearAll.id = "clear-all-regions-btn";
        clearAll.textContent = "Clear all";
        e.activeRegions.appendChild(clearAll);
        e.activeRegions
          .querySelectorAll<HTMLButtonElement>(".aoi-chip-remove")
          .forEach((btn) => {
            btn.addEventListener("click", () => {
              const id = Number(btn.dataset.aoiId);
              removeRegion(id);
            });
          });
        document
          .getElementById("clear-all-regions-btn")
          ?.addEventListener("click", clearAllRegions);
      }
    }
  }

  if (e.topkSlider) {
    e.topkSlider.value = String(state.topK);
    syncSliderFill(e.topkSlider);
  }
  if (e.topkValue) e.topkValue.textContent = String(state.topK);

  e.viewTabs.forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === state.viewMode);
  });
  if (e.topkControl) e.topkControl.hidden = state.viewMode !== "topk";
  if (e.heatmapLegend) e.heatmapLegend.hidden = state.viewMode !== "heatmap";
  if (e.outlierLegend) e.outlierLegend.hidden = state.viewMode !== "outlier";
  if (e.surpriseLegend) e.surpriseLegend.hidden = state.viewMode !== "surprise";
  if (e.gradientLegend)
    e.gradientLegend.hidden =
      state.viewMode !== "gradient" || !state.results.length;
  if (e.gradientMsg)
    e.gradientMsg.hidden =
      state.viewMode !== "gradient" || state.results.length > 0;
  if (e.thresholdControl)
    e.thresholdControl.hidden = state.viewMode !== "threshold";

  if (state.viewMode === "threshold" && state.results.length) {
    const scores = state.results.map((r) => r.score);
    const mn = Math.min(...scores);
    const mx = Math.max(...scores);
    if (e.thresholdSlider) {
      e.thresholdSlider.min = String(mn);
      e.thresholdSlider.max = String(mx);
      if (state.threshold === Infinity)
        state.threshold = scores[Math.min(state.topK, scores.length) - 1] ?? mx;
      e.thresholdSlider.value = String(state.threshold);
      e.thresholdSlider.step = String(Math.max(0.1, (mx - mn) / 200));
      syncSliderFill(e.thresholdSlider);
    }
    if (e.thresholdValue)
      e.thresholdValue.textContent = state.threshold.toFixed(1);
    const below = state.results.filter(
      (r) => r.score <= state.threshold,
    ).length;
    if (e.thresholdCount) e.thresholdCount.textContent = String(below);
    if (e.histogramWrap)
      e.histogramWrap.innerHTML = renderHistogram(scores, state.threshold);
  }

  if (e.exemplarCount)
    e.exemplarCount.textContent = String(state.positivePoints.length);
  if (e.clearPointsBtn)
    e.clearPointsBtn.hidden = state.positivePoints.length === 0;
  if (e.exportBtn) e.exportBtn.hidden = state.results.length === 0;
  e.overlayToggle?.classList.toggle("is-on", state.overlayVisible);
  e.invertToggle?.classList.toggle("is-on", state.invertSearch);
  if (e.combineSelect) {
    e.combineSelect.value = state.combineMethod;
    e.combineSelect.hidden = state.positivePoints.length < 2;
  }

  if (e.negativeSection)
    e.negativeSection.hidden = state.negativePoints.length === 0;
  const negKey = state.negativePoints.map((p) => p.id).join(",");
  if (
    e.negativeList &&
    state.negativePoints.length &&
    negKey !== lastNegativeListKey
  ) {
    lastNegativeListKey = negKey;
    e.negativeList.innerHTML = "";
    for (const [i, p] of state.negativePoints.entries()) {
      const li = document.createElement("li");
      li.className = "exemplar-item neg-item";
      li.style.setProperty("--i", String(i));
      li.innerHTML = `
        <button type="button" data-nid="${p.id}">
          <span class="ex-index neg-index">N${String(p.id).padStart(2, "0")}</span>
          <span class="ex-coord">${formatLatLng(p.lat, p.lng)}</span>
          <span class="ex-remove" aria-hidden="true">\u00d7</span>
        </button>
      `;
      e.negativeList.appendChild(li);
    }
    e.negativeList
      .querySelectorAll<HTMLButtonElement>("button[data-nid]")
      .forEach((b) => {
        b.addEventListener("click", (ev) => {
          const target = ev.target as HTMLElement;
          const nid = Number(b.dataset.nid);
          if (target.closest(".ex-remove")) {
            state.negativePoints = state.negativePoints
              .filter((p) => p.id !== nid)
              .map((p, idx) => ({ ...p, id: idx + 1 }));
            lastNegativeListKey = "";
            globe.setNegatives(state.negativePoints);
            void scoreCandidates();
            updateView();
          } else {
            const pt = state.negativePoints.find((p) => p.id === nid);
            if (pt) globe.map.flyTo({ center: [pt.lng, pt.lat], zoom: 13 });
          }
        });
      });
  }

  const positiveKey = state.positivePoints.map((p) => p.id).join(",");
  if (positiveKey !== lastPositiveListKey) {
    lastPositiveListKey = positiveKey;
    e.positiveList.innerHTML = "";
    if (!state.positivePoints.length) {
      e.positiveList.innerHTML = `<li class="empty">No exemplars yet \u2014 click anywhere on the map to seed the search.</li>`;
    } else {
      for (const [i, p] of state.positivePoints.entries()) {
        const li = document.createElement("li");
        li.className = "exemplar-item";
        li.style.setProperty("--i", String(i));
        const isExternal = Boolean(p.embedding);
        li.innerHTML = `
        <button type="button" data-pid="${p.id}">
          <span class="ex-index">${isExternal ? "\u2295" : "E"}${String(p.id).padStart(2, "0")}</span>
          <span class="ex-coord">${formatLatLng(p.lat, p.lng)}</span>
          <span class="ex-remove" aria-hidden="true">\u00d7</span>
        </button>
      `;
        e.positiveList.appendChild(li);
      }
      e.positiveList
        .querySelectorAll<HTMLButtonElement>("button[data-pid]")
        .forEach((b) => {
          b.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement;
            const pid = Number(b.dataset.pid);
            if (target.closest(".ex-remove")) {
              state.positivePoints = state.positivePoints
                .filter((p) => p.id !== pid)
                .map((p, idx) => ({ ...p, id: idx + 1 }));
              lastPositiveListKey = "\0";
              globe.setPositives(state.positivePoints);
              void scoreCandidates();
              updateView();
            } else {
              const pt = state.positivePoints.find((p) => p.id === pid);
              if (pt) globe.map.flyTo({ center: [pt.lng, pt.lat], zoom: 13 });
            }
          });
        });
    }
  }

  const activeResults =
    state.viewMode === "outlier"
      ? state.outlierResults
      : state.viewMode === "surprise"
        ? state.surpriseResults
        : state.viewMode === "gradient"
          ? state.gradientResults
          : state.results;
  const visible =
    state.viewMode === "topk"
      ? activeResults.slice(0, state.topK)
      : state.viewMode === "threshold"
        ? activeResults.filter((r) => r.score <= state.threshold)
        : activeResults.slice(0, state.topK);

  if (e.resultCount) {
    const needsExemplars =
      state.viewMode !== "outlier" && state.viewMode !== "surprise";
    if (!state.candidateRows.length) e.resultCount.textContent = "";
    else if (needsExemplars && !state.positivePoints.length)
      e.resultCount.textContent = "";
    else if (state.viewMode === "threshold")
      e.resultCount.textContent = `${compactNum(visible.length)} / ${compactNum(activeResults.length)}`;
    else if (state.viewMode === "topk")
      e.resultCount.textContent = `${visible.length} / ${compactNum(activeResults.length)}`;
    else
      e.resultCount.textContent = `${compactNum(activeResults.length)} scored`;
  }

  const resultKey = `${state.viewMode}|${visible.map((r) => r.chips_id).join(",")}`;
  if (resultKey !== lastResultListKey) {
    lastResultListKey = resultKey;
    e.resultList.innerHTML = "";
    if (visible.length) {
      for (const [i, r] of visible.entries()) {
        const c = centroid(r.bbox);
        const li = document.createElement("li");
        li.className = "result-item";
        li.style.setProperty("--i", String(i));
        li.innerHTML = `
        <button type="button" data-chip="${r.chips_id}">
          <span class="rank">${String(i + 1).padStart(2, "0")}</span>
          <span class="rank-body">
            <span class="rank-coord">${formatLatLng(c.lat, c.lng)}</span>
          </span>
          <span class="rank-score">${r.score.toFixed(1)}</span>
        </button>
      `;
        e.resultList.appendChild(li);
      }
      e.resultList
        .querySelectorAll<HTMLButtonElement>("button[data-chip]")
        .forEach((b) => {
          const row = activeResults.find((r) => r.chips_id === b.dataset.chip);
          if (!row) return;
          b.addEventListener("mouseenter", () => globe.setPreview(row));
          b.addEventListener("focus", () => globe.setPreview(row));
          b.addEventListener("mouseleave", () => globe.setPreview(null));
          b.addEventListener("blur", () => globe.setPreview(null));
          b.addEventListener("click", () =>
            globe.flyToBBox(row.bbox, { zoom: 13 }),
          );
        });
    }
  }
}

/* ---------------------------------------------------------- Scoring (worker) */

type WorkerScoreResult = { index: number; score: number };

function ensureScoringWorker(): Worker {
  if (scoringWorker) return scoringWorker;
  scoringWorker = new Worker(new URL("./scoring-worker.ts", import.meta.url), {
    type: "module",
  });
  scoringWorker.addEventListener("error", () => {
    scoringWorkerReady = false;
  });
  return scoringWorker;
}

function initScoringWorker(candidates: CandidateRow[]): void {
  const worker = ensureScoringWorker();
  const centroids = new Float64Array(candidates.length * 2);
  for (let i = 0; i < candidates.length; i++) {
    const c = centroid(candidates[i].bbox);
    centroids[i * 2] = c.lat;
    centroids[i * 2 + 1] = c.lng;
  }
  worker.postMessage({
    type: "init",
    embeddings: candidates.map((c) => new Uint8Array(c.embedding)),
    centroids,
  });
  scoringWorkerReady = true;
}

function combineEmbeddings(
  embeddings: Uint8Array[],
  method: CombineMethod,
): Uint8Array[] {
  if (embeddings.length <= 1 || method === "mean") return embeddings;
  const len = embeddings[0].length;
  const result = new Uint8Array(len);
  if (method === "and") {
    result.set(embeddings[0]);
    for (let e = 1; e < embeddings.length; e++) {
      for (let i = 0; i < len; i++) result[i] &= embeddings[e][i];
    }
  } else if (method === "or") {
    for (let e = 0; e < embeddings.length; e++) {
      for (let i = 0; i < len; i++) result[i] |= embeddings[e][i];
    }
  } else if (method === "xor") {
    for (let e = 0; e < embeddings.length; e++) {
      for (let i = 0; i < len; i++) result[i] ^= embeddings[e][i];
    }
  }
  return [result];
}

function applyInvert(base: RankedRow[]): RankedRow[] {
  if (!state.invertSearch || !base.length) return base;
  const hasNeg = state.negativePoints.length > 0;
  const L = base[0].embedding.length * 8;
  return [...base]
    .map((r) => ({ ...r, score: hasNeg ? -r.score : L - r.score }))
    .reverse();
}

function resolveNegativeEmbeddings(): Uint8Array[] {
  return state.negativePoints.flatMap((point) => {
    if (point.embedding) return [point.embedding];
    const intersecting = state.candidateRows.filter((c) =>
      containsPoint(c.bbox, point.lat, point.lng),
    );
    if (!intersecting.length) return [];
    let best = intersecting[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const option of intersecting) {
      const c = centroid(option.bbox);
      const d = distanceSquared(point.lat, point.lng, c.lat, c.lng);
      if (d < bestD) {
        bestD = d;
        best = option;
      }
    }
    return [best.embedding];
  });
}

async function scoreWithWorker(
  exemplars: CandidateRow[],
): Promise<RankedRow[]> {
  if (!scoringWorkerReady) return [];
  const worker = ensureScoringWorker();
  const requestId = ++scoringRequestId;
  const excludeIndices = new Set(
    exemplars
      .map((ex) => state.candidateRows.indexOf(ex))
      .filter((i) => i >= 0),
  );
  let posEmbeddings = exemplars.map((ex) => new Uint8Array(ex.embedding));
  posEmbeddings = combineEmbeddings(posEmbeddings, state.combineMethod);
  const negEmbeddings = resolveNegativeEmbeddings();
  const results = await new Promise<WorkerScoreResult[]>((resolve, reject) => {
    const onMessage = (
      event: MessageEvent<{
        type: string;
        requestId: number;
        results: WorkerScoreResult[];
      }>,
    ) => {
      if (
        event.data.type !== "score-result" ||
        event.data.requestId !== requestId
      )
        return;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      resolve(event.data.results);
    };
    const onError = (event: ErrorEvent) => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      scoringWorkerReady = false;
      reject(event.error ?? new Error(event.message));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({
      type: "score",
      requestId,
      exemplars: posEmbeddings,
      negatives: negEmbeddings,
      excludeIndices: [...excludeIndices],
    });
  });
  return results.map(({ index, score }) => ({
    ...state.candidateRows[index],
    score,
  }));
}

function resolvePositiveMatches(): PositiveMatch[] {
  return state.positivePoints.flatMap((point) => {
    if (point.embedding && point.chips_id) {
      return [
        {
          pointId: point.id,
          candidate: {
            chips_id: point.chips_id,
            bbox: {
              west: point.lng - 0.005,
              south: point.lat - 0.005,
              east: point.lng + 0.005,
              north: point.lat + 0.005,
            },
            embedding: point.embedding,
            shard_path: "",
          },
        },
      ];
    }
    const intersecting = state.candidateRows.filter((c) =>
      containsPoint(c.bbox, point.lat, point.lng),
    );
    if (!intersecting.length) return [];
    let best = intersecting[0];
    let bestD = Number.POSITIVE_INFINITY;
    for (const option of intersecting) {
      const c = centroid(option.bbox);
      const d = distanceSquared(point.lat, point.lng, c.lat, c.lng);
      if (d < bestD) {
        bestD = d;
        best = option;
      }
    }
    return [{ pointId: point.id, candidate: best }];
  });
}

async function scoreCandidates(): Promise<void> {
  const runId = ++latestScoreRunId;

  if (state.loading || !scoringWorkerReady) {
    if (state.positivePoints.length) {
      if (state.loading) {
        setStatus(
          `Queued ${state.positivePoints.length} exemplar(s) \u2014 waiting for shards to finish downloading\u2026`,
        );
      } else {
        setStatus(
          "Exemplar set \u2014 shift-drag to define a region and start searching.",
        );
      }
    }
    return;
  }

  if (!state.candidateRows.length || !state.positivePoints.length) {
    state.positiveMatches = [];
    state.baseResults = [];
    state.results = [];
    globe.setPositiveMatches([]);
    globe.setResults([], state.topK, state.viewMode);
    globe.setPreview(null);
    updateView();
    return;
  }

  state.positiveMatches = resolvePositiveMatches();
  const exemplars = state.positiveMatches.map((m) => m.candidate);
  globe.setPositiveMatches(state.positiveMatches);

  if (!exemplars.length) {
    state.baseResults = [];
    state.results = [];
    globe.setResults([], state.topK, state.viewMode);
    setStatus(
      "No patch under the selected point \u2014 try closer to a tile center.",
    );
    return;
  }

  setStatus(
    `Scoring ${new Intl.NumberFormat().format(state.candidateRows.length)} candidates\u2026`,
  );
  const scored = await scoreWithWorker(exemplars);
  if (runId !== latestScoreRunId) return;
  state.baseResults = scored;
  state.results = applyInvert(scored);
  if (state.overlayVisible)
    globe.setResults(scored, state.topK, state.viewMode);
  setStatus(
    `Ranked ${scored.length} candidates against ${exemplars.length} exemplar(s).`,
  );
  updateView();
  void computeGradient(true);
}

/* ---------------------------------------------------------- Overlay toggle */

function activeResultsForMode(): RankedRow[] {
  if (state.viewMode === "outlier") return state.outlierResults;
  if (state.viewMode === "surprise") return state.surpriseResults;
  if (state.viewMode === "gradient") return state.gradientResults;
  return state.results;
}

function applyOverlay(): void {
  if (state.overlayVisible) {
    const activeResults = activeResultsForMode();
    if (state.viewMode === "threshold") {
      const filtered = activeResults.filter((r) => r.score <= state.threshold);
      globe.setResults(filtered, filtered.length, state.viewMode);
    } else {
      globe.setResults(activeResults, state.topK, state.viewMode);
    }
  } else {
    globe.setResults([], 0, state.viewMode);
  }
}

/* ---------------------------------------------------------- Outlier scoring */

async function computeOutliers(background = false): Promise<void> {
  if (!scoringWorkerReady || !state.candidateRows.length) return;
  if (state.outlierComputed || outlierComputing) return;
  outlierComputing = true;
  const myEpoch = outlierEpoch;

  if (!background) setStatus("Computing outlier scores\u2026");
  const worker = ensureScoringWorker();
  const requestId = ++scoringRequestId;
  try {
    const results = await new Promise<WorkerScoreResult[]>(
      (resolve, reject) => {
        const onMessage = (
          event: MessageEvent<{
            type: string;
            requestId: number;
            results: WorkerScoreResult[];
          }>,
        ) => {
          if (
            event.data.type !== "outlier-result" ||
            event.data.requestId !== requestId
          )
            return;
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          resolve(event.data.results);
        };
        const onError = (event: ErrorEvent) => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          reject(event.error ?? new Error(event.message));
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage({ type: "outlier", requestId, sampleSize: 200 });
      },
    );
    if (outlierEpoch !== myEpoch) return;
    state.outlierResults = results.map(({ index, score }) => ({
      ...state.candidateRows[index],
      score,
    }));
    state.outlierComputed = true;
    if (state.viewMode === "outlier" || !background) {
      if (state.overlayVisible)
        globe.setResults(state.outlierResults, state.topK, "outlier");
      setStatus(
        `Outlier analysis: ${state.outlierResults.length} patches scored. Brightest = most unique.`,
      );
      updateView();
    }
  } finally {
    outlierComputing = false;
  }
}

/* ---------------------------------------------------------- Surprise scoring */

async function computeSurprise(background = false): Promise<void> {
  if (!scoringWorkerReady || !state.candidateRows.length) return;
  if (state.surpriseComputed || surpriseComputing) return;
  surpriseComputing = true;
  const myEpoch = surpriseEpoch;

  if (!background) setStatus("Computing spatial surprise scores\u2026");
  const worker = ensureScoringWorker();
  const requestId = ++scoringRequestId;
  try {
    const results = await new Promise<WorkerScoreResult[]>(
      (resolve, reject) => {
        const onMessage = (
          event: MessageEvent<{
            type: string;
            requestId: number;
            results: WorkerScoreResult[];
          }>,
        ) => {
          if (
            event.data.type !== "surprise-result" ||
            event.data.requestId !== requestId
          )
            return;
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          resolve(event.data.results);
        };
        const onError = (event: ErrorEvent) => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          reject(event.error ?? new Error(event.message));
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage({ type: "surprise", requestId, k: 8 });
      },
    );
    if (surpriseEpoch !== myEpoch) return;
    state.surpriseResults = results.map(({ index, score }) => ({
      ...state.candidateRows[index],
      score,
    }));
    state.surpriseComputed = true;
    if (state.viewMode === "surprise" || !background) {
      if (state.overlayVisible)
        globe.setResults(state.surpriseResults, state.topK, "surprise");
      setStatus(
        `Surprise analysis: ${state.surpriseResults.length} patches scored. Brightest = most surprising.`,
      );
      updateView();
    }
  } finally {
    surpriseComputing = false;
  }
}

/* ---------------------------------------------------------- Gradient scoring */

async function computeGradient(background = false): Promise<void> {
  if (
    !scoringWorkerReady ||
    !state.candidateRows.length ||
    !state.results.length
  )
    return;
  if (gradientComputing) return;
  gradientComputing = true;

  if (!background) setStatus("Computing similarity gradient\u2026");
  const worker = ensureScoringWorker();
  const requestId = ++scoringRequestId;
  const scoreArr = new Float64Array(state.candidateRows.length);
  const scoreMap = new Map<string, number>();
  for (const r of state.results) scoreMap.set(r.chips_id, r.score);
  for (let i = 0; i < state.candidateRows.length; i++) {
    scoreArr[i] = scoreMap.get(state.candidateRows[i].chips_id) ?? 0;
  }
  try {
    const results = await new Promise<WorkerScoreResult[]>(
      (resolve, reject) => {
        const onMessage = (
          event: MessageEvent<{
            type: string;
            requestId: number;
            results: WorkerScoreResult[];
          }>,
        ) => {
          if (
            event.data.type !== "gradient-result" ||
            event.data.requestId !== requestId
          )
            return;
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          resolve(event.data.results);
        };
        const onError = (event: ErrorEvent) => {
          worker.removeEventListener("message", onMessage);
          worker.removeEventListener("error", onError);
          reject(event.error ?? new Error(event.message));
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.postMessage({
          type: "gradient",
          requestId,
          scores: scoreArr,
          k: 6,
        });
      },
    );
    state.gradientResults = results.map(({ index, score }) => ({
      ...state.candidateRows[index],
      score,
    }));
    if (state.viewMode === "gradient" || !background) {
      if (state.overlayVisible)
        globe.setResults(state.gradientResults, state.topK, "gradient");
      setStatus(
        `Gradient analysis: ${state.gradientResults.length} patches scored. Brightest = strongest boundary.`,
      );
      updateView();
    }
  } finally {
    gradientComputing = false;
  }
}

/* ---------------------------------------------------------- App actions */

async function addRegion(
  bbox: BBox,
  polygon?: [number, number][],
): Promise<void> {
  const id = state.nextAoiId++;
  const runId = 1;
  regionLoadRunIds.set(id, runId);

  state.bboxes.push({ id, bbox, ...(polygon ? { polygon } : {}) });
  state.regionRows.set(id, []);
  state.regionShardCounts.set(id, 0);
  state.loading = true;
  resetComputeState();
  state.baseResults = [];
  state.results = [];
  state.outlierResults = [];
  state.outlierComputed = false;
  outlierEpoch++;
  state.surpriseResults = [];
  state.surpriseComputed = false;
  surpriseEpoch++;
  state.gradientResults = [];
  state.threshold = Infinity;
  state.positiveMatches = [];
  globe.setAois(state.bboxes);
  globe.setPositiveMatches([]);
  globe.setResults([], state.topK, state.viewMode);
  globe.setPreview(null);
  globe.fitBounds(bbox, { padding: 60 });
  setStatus("Fetching intersecting shards\u2026");
  updateView();

  try {
    const db = await getDuckDB();
    const conn = await db.connect();
    const manifestResult = await conn.query(buildManifestQuery(bbox, polygon));
    const shards = manifestResult.toArray() as ManifestRow[];
    await conn.close();
    if (regionLoadRunIds.get(id) !== runId) {
      state.loading = false;
      return;
    }

    state.regionShardCounts.set(id, shards.length);
    updateView();
    if (!shards.length) {
      state.loading = false;
      setStatus("No shards intersect that region.");
      return;
    }

    setStatus(
      `Loading patches from ${shards.length} shard(s) for AOI ${id}\u2026`,
    );

    let completed = 0;
    const shardUrls = shards.map((s) => resolveShardUrl(s.path));
    const regionAll: CandidateRow[] = [];
    const settled = await mapWithConcurrency(shardUrls, 8, async (url) => {
      const rows = await fetchShardCandidates(db, url, bbox, polygon);
      if (regionLoadRunIds.get(id) !== runId) return rows;
      regionAll.push(...rows);
      state.regionRows.get(id)?.push(...rows);
      state.candidateRows = [...state.regionRows.values()].flat();
      completed += 1;
      setStatus(
        `AOI ${id} \u2014 ${completed}/${shards.length} shards \u00b7 ${new Intl.NumberFormat().format(state.candidateRows.length)} total patches`,
      );
      return rows;
    });
    if (regionLoadRunIds.get(id) !== runId) {
      state.loading = false;
      return;
    }

    const failed = settled.filter((r) => r.status === "rejected");
    if (failed.length) console.warn(`AOI ${id} shard fetch failures:`, failed);

    state.regionRows.set(id, regionAll);
    state.candidateRows = [...state.regionRows.values()].flat();
    initScoringWorker(state.candidateRows);
    state.loading = false;
    const totalPatches = new Intl.NumberFormat().format(
      state.candidateRows.length,
    );
    const base = regionAll.length
      ? `AOI ${id} loaded \u2014 ${totalPatches} total patches. Click anywhere to seed an exemplar.`
      : `AOI ${id} loaded, but no patches returned.`;
    setStatus(
      failed.length ? `${base} (${failed.length} shard(s) failed)` : base,
    );
    updateView();

    if (state.positivePoints.length && state.candidateRows.length) {
      void scoreCandidates();
    }
    void computeOutliers(true);
    void computeSurprise(true);
  } catch (err) {
    state.loading = false;
    if (regionLoadRunIds.get(id) !== runId) return;
    setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function removeRegion(id: number): void {
  lastPositiveListKey = "\0";
  lastNegativeListKey = "\0";
  lastResultListKey = "";
  state.bboxes = state.bboxes.filter((e) => e.id !== id);
  state.regionRows.delete(id);
  state.regionShardCounts.delete(id);
  regionLoadRunIds.delete(id);
  if (!state.bboxes.length) state.loading = false;
  resetComputeState();
  state.candidateRows = [...state.regionRows.values()].flat();
  state.baseResults = [];
  state.results = [];
  state.outlierResults = [];
  state.outlierComputed = false;
  outlierEpoch++;
  state.surpriseResults = [];
  state.surpriseComputed = false;
  surpriseEpoch++;
  state.gradientResults = [];
  state.positiveMatches = [];
  globe.setAois(state.bboxes);
  globe.setPositiveMatches([]);
  globe.setResults([], state.topK, state.viewMode);
  if (state.candidateRows.length) {
    initScoringWorker(state.candidateRows);
    if (state.positivePoints.length) void scoreCandidates();
  }
  setStatus(
    state.bboxes.length
      ? "Region removed. Remaining regions active."
      : "Cleared. Shift-drag to define a new region.",
  );
  updateView();
}

function findNearestCandidate(lat: number, lng: number): CandidateRow | null {
  const intersecting = state.candidateRows.filter((c) =>
    containsPoint(c.bbox, lat, lng),
  );
  if (!intersecting.length) return null;
  let best = intersecting[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const option of intersecting) {
    const c = centroid(option.bbox);
    const d = distanceSquared(lat, lng, c.lat, c.lng);
    if (d < bestD) {
      bestD = d;
      best = option;
    }
  }
  return best;
}

async function fetchExternalEmbedding(
  lat: number,
  lng: number,
): Promise<CandidateRow | null> {
  const db = await getDuckDB();
  const conn = await db.connect();
  try {
    const mResult = await conn.query(
      `
      SELECT path FROM read_parquet(${sqlString(MANIFEST_URL)})
      WHERE xmin <= ${lng} AND xmax >= ${lng}
        AND ymin <= ${lat} AND ymax >= ${lat}
      ORDER BY rows ASC LIMIT 5
    `.trim(),
    );
    const shards = mResult.toArray() as Array<{ path: string }>;
    if (!shards.length) return null;

    for (const shard of shards) {
      const url = resolveShardUrl(shard.path);
      const p1 = await conn.query(
        `
        SELECT chips_id, bbox
        FROM read_parquet(${sqlString(url)})
        WHERE bbox.xmax >= ${lng - 0.01} AND bbox.xmin <= ${lng + 0.01}
          AND bbox.ymax >= ${lat - 0.01} AND bbox.ymin <= ${lat + 0.01}
      `.trim(),
      );
      const candidates = p1.toArray() as Array<{
        chips_id: string;
        bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
      }>;
      const hit = candidates.find((r) =>
        containsPoint(normalizeBBox(r.bbox), lat, lng),
      );
      if (!hit) continue;

      const p2 = await conn.query(
        `
        SELECT embedding
        FROM read_parquet(${sqlString(url)})
        WHERE chips_id = ${sqlString(hit.chips_id)}
        LIMIT 1
      `.trim(),
      );
      const embRow = p2.toArray()[0] as { embedding: unknown } | undefined;
      if (!embRow) continue;

      return {
        chips_id: hit.chips_id,
        bbox: normalizeBBox(hit.bbox),
        embedding: normalizeEmbedding(embRow.embedding),
        shard_path: url,
      };
    }
    return null;
  } finally {
    await conn.close();
  }
}

function addPositive(lat: number, lng: number): void {
  const insideBbox = isInsideAnyAoi(lat, lng);
  const candidatesReady = state.candidateRows.length > 0;

  if (insideBbox && candidatesReady) {
    const patch = findNearestCandidate(lat, lng);
    if (patch) {
      const existing = state.positivePoints.some((p) => {
        const ep = findNearestCandidate(p.lat, p.lng);
        return ep && ep.chips_id === patch.chips_id;
      });
      if (existing) return;
    }
    state.positivePoints.push({
      id: state.positivePoints.length + 1,
      lat,
      lng,
    });
    globe.setPositives(state.positivePoints);
    void scoreCandidates();
    updateView();
  } else if (insideBbox) {
    state.positivePoints.push({
      id: state.positivePoints.length + 1,
      lat,
      lng,
    });
    globe.setPositives(state.positivePoints);
    void scoreCandidates();
    updateView();
  } else {
    const placeholderId = state.positivePoints.length + 1;
    state.positivePoints.push({ id: placeholderId, lat, lng });
    globe.setPositives(state.positivePoints);
    setStatus("Fetching external exemplar embedding\u2026");
    updateView();
    void fetchExternalEmbedding(lat, lng).then((row) => {
      if (!row) {
        state.positivePoints = state.positivePoints.filter(
          (p) => p.id !== placeholderId,
        );
        globe.setPositives(state.positivePoints);
        setStatus("No patch found at that location.");
        updateView();
        return;
      }
      const existing = state.positivePoints.some(
        (p) => p.embedding && p.chips_id === row.chips_id,
      );
      if (existing) {
        state.positivePoints = state.positivePoints.filter(
          (p) => p.id !== placeholderId,
        );
        globe.setPositives(state.positivePoints);
        setStatus("That patch is already selected.");
        updateView();
        return;
      }
      const placeholder = state.positivePoints.find(
        (p) => p.id === placeholderId,
      );
      if (placeholder) {
        placeholder.embedding = row.embedding;
        placeholder.chips_id = row.chips_id;
      }
      globe.setPositives(state.positivePoints);
      void scoreCandidates();
      updateView();
    });
  }
}

function addNegative(lat: number, lng: number): void {
  const insideBbox = isInsideAnyAoi(lat, lng);
  const candidatesReady = state.candidateRows.length > 0;

  if (insideBbox && candidatesReady) {
    const patch = findNearestCandidate(lat, lng);
    if (patch) {
      const existing = state.negativePoints.some((p) => {
        const ep = findNearestCandidate(p.lat, p.lng);
        return ep && ep.chips_id === patch.chips_id;
      });
      if (existing) return;
    }
    state.negativePoints.push({
      id: state.negativePoints.length + 1,
      lat,
      lng,
    });
    globe.setNegatives(state.negativePoints);
    void scoreCandidates();
    updateView();
  } else if (insideBbox) {
    state.negativePoints.push({
      id: state.negativePoints.length + 1,
      lat,
      lng,
    });
    globe.setNegatives(state.negativePoints);
    void scoreCandidates();
    updateView();
  } else {
    const placeholderId = state.negativePoints.length + 1;
    state.negativePoints.push({ id: placeholderId, lat, lng });
    globe.setNegatives(state.negativePoints);
    setStatus("Fetching external negative embedding\u2026");
    updateView();
    void fetchExternalEmbedding(lat, lng).then((row) => {
      if (!row) {
        state.negativePoints = state.negativePoints.filter(
          (p) => p.id !== placeholderId,
        );
        globe.setNegatives(state.negativePoints);
        setStatus("No patch found at that location.");
        updateView();
        return;
      }
      const existing = state.negativePoints.some(
        (p) => p.embedding && p.chips_id === row.chips_id,
      );
      if (existing) {
        state.negativePoints = state.negativePoints.filter(
          (p) => p.id !== placeholderId,
        );
        globe.setNegatives(state.negativePoints);
        setStatus("That patch is already a negative.");
        updateView();
        return;
      }
      const placeholder = state.negativePoints.find(
        (p) => p.id === placeholderId,
      );
      if (placeholder) {
        placeholder.embedding = row.embedding;
        placeholder.chips_id = row.chips_id;
      }
      globe.setNegatives(state.negativePoints);
      void scoreCandidates();
      updateView();
    });
  }
}

function clearNegatives(): void {
  if (!state.negativePoints.length) return;
  state.negativePoints = [];
  globe.setNegatives([]);
  void scoreCandidates();
  updateView();
}

function clearPoints(): void {
  if (!state.positivePoints.length && !state.negativePoints.length) return;
  state.positivePoints = [];
  state.negativePoints = [];
  lastPositiveListKey = "\0";
  lastNegativeListKey = "\0";
  lastResultListKey = "";
  gradientComputing = false;
  state.positiveMatches = [];
  state.baseResults = [];
  state.results = [];
  state.gradientResults = [];
  globe.setPositives([]);
  globe.setNegatives([]);
  globe.setPositiveMatches([]);
  globe.setResults([], state.topK, state.viewMode);
  globe.setPreview(null);
  setStatus("Exemplar points cleared. Click anywhere to seed new ones.");
  updateView();
}

function clearAllRegions(): void {
  lastPositiveListKey = "\0";
  lastNegativeListKey = "\0";
  lastResultListKey = "";
  state.bboxes = [];
  state.nextAoiId = 1;
  state.regionRows = new Map();
  state.regionShardCounts = new Map();
  regionLoadRunIds.clear();
  state.loading = false;
  state.candidateRows = [];
  state.positivePoints = [];
  state.negativePoints = [];
  state.positiveMatches = [];
  resetComputeState();
  state.baseResults = [];
  state.results = [];
  state.topK = DEFAULT_TOP_K;
  state.viewMode = "topk";
  state.outlierResults = [];
  state.outlierComputed = false;
  outlierEpoch++;
  state.surpriseResults = [];
  state.surpriseComputed = false;
  surpriseEpoch++;
  state.gradientResults = [];
  state.threshold = Infinity;
  state.invertSearch = false;
  state.combineMethod = "mean";
  globe.setAois([]);
  globe.setPositives([]);
  globe.setNegatives([]);
  globe.setPositiveMatches([]);
  globe.setResults([], state.topK, state.viewMode);
  globe.setPreview(null);
  setStatus("Cleared. Shift-drag to define a new region.");
  updateView();
}

/* --------------------------------------------------------------- Bootstrap */

function wire(): void {
  const e = els();
  e.drawModeRect?.addEventListener("click", () => {
    const wasArmed = globe.isArmed() && globe.getDrawMode() === "rect";
    globe.armDraw(!wasArmed, "rect");
    setStatus(
      wasArmed
        ? "Draw disarmed."
        : "Draw armed \u2014 drag on the globe to define a region.",
    );
    updateView();
  });
  e.drawModePoly?.addEventListener("click", () => {
    const wasArmed = globe.isArmed() && globe.getDrawMode() === "polygon";
    globe.armDraw(!wasArmed, "polygon");
    if (!wasArmed) {
      const hint = isMobileViewport()
        ? "Polygon draw armed \u2014 tap to add vertices, tap Done to close."
        : "Polygon draw armed \u2014 click to add vertices, double-click to close.";
      setStatus(hint);
    } else {
      setStatus("Draw disarmed.");
    }
    syncPolyDoneBtn();
    updateView();
  });

  e.polyDoneBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (globe.finishPolygon()) syncPolyDoneBtn();
  });
  e.zoomRegionBtn?.addEventListener("click", () => {
    if (!state.bboxes.length) return;
    const union: BBox = {
      west: Math.min(...state.bboxes.map((e) => e.bbox.west)),
      south: Math.min(...state.bboxes.map((e) => e.bbox.south)),
      east: Math.max(...state.bboxes.map((e) => e.bbox.east)),
      north: Math.max(...state.bboxes.map((e) => e.bbox.north)),
    };
    globe.fitBounds(union, { padding: 60 });
  });
  e.clearPointsBtn?.addEventListener("click", clearPoints);
  e.exportBtn?.addEventListener(
    "click",
    () =>
      void exportGeoParquet(
        state.positiveMatches,
        state.results,
        state.topK,
        state.viewMode,
        setStatus,
      ),
  );
  e.overlayToggle?.addEventListener("click", () => {
    state.overlayVisible = !state.overlayVisible;
    applyOverlay();
    e.overlayToggle?.classList.toggle("is-on", state.overlayVisible);
  });

  // Help popovers
  const helpContent: Record<string, string> = {
    retrieval: `<p class="overlay-help-title">Overlay modes</p><ul class="overlay-help-list"><li><strong>Top-K</strong> \u2014 Ranked list of the N most similar patches to your query.</li><li><strong>Heat</strong> \u2014 Similarity heatmap across all patches; bright = close match.</li><li><strong>Cutoff</strong> \u2014 All patches within a max Hamming distance you set.</li><li><strong>Outlier</strong> \u2014 Patches most unlike the rest of the visible region.</li><li><strong>Surprise</strong> \u2014 Patches that differ sharply from their spatial neighbors.</li><li><strong>Edge</strong> \u2014 Boundaries where similarity scores change abruptly.</li></ul>`,
    explore: `<p class="overlay-help-title">Explore</p><p class="panel-info-body">Curated regions based on prior knowledge \u2014 interesting places around the world to search within.</p>`,
    discoveries: `<p class="overlay-help-title">Discoveries</p><p class="panel-info-body">Interesting locations surfaced automatically by analyzing the embeddings \u2014 outliers, surprising patches, and boundary regions found without manual curation.</p>`,
  };
  const helpPopover = document.createElement("div");
  helpPopover.className = "help-popover";
  helpPopover.setAttribute("role", "tooltip");
  document.body.appendChild(helpPopover);
  document
    .querySelectorAll<HTMLButtonElement>("button[data-help]")
    .forEach((btn) => {
      btn.addEventListener("mouseenter", () => {
        const key = btn.dataset.help ?? "";
        if (!helpContent[key]) return;
        helpPopover.innerHTML = helpContent[key];
        const r = btn.getBoundingClientRect();
        helpPopover.style.top = `${r.bottom + 8}px`;
        helpPopover.style.right = `${window.innerWidth - r.right}px`;
        helpPopover.style.display = "block";
      });
      btn.addEventListener("mouseleave", () => {
        helpPopover.style.display = "none";
      });
    });

  e.topkSlider?.addEventListener("input", (ev) => {
    state.topK = Number((ev.currentTarget as HTMLInputElement).value);
    globe.setResults(state.results, state.topK, state.viewMode);
    updateView();
  });
  e.thresholdSlider?.addEventListener("input", (ev) => {
    state.threshold = Number((ev.currentTarget as HTMLInputElement).value);
    const filtered = state.results.filter((r) => r.score <= state.threshold);
    globe.setResults(filtered, filtered.length, "threshold");
    updateView();
  });

  // View mode tabs
  e.viewTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const mode = tab.dataset.view as ViewMode;
      state.viewMode = mode;
      if (mode === "outlier" && state.outlierComputed) {
        globe.setResults(state.outlierResults, state.topK, mode);
        setStatus(
          `Outlier view \u2014 ${state.outlierResults.length} patches scored. Brightest = most unique.`,
        );
      } else if (mode === "outlier" && outlierComputing) {
        setStatus(
          "Computing outlier scores\u2026 results will appear shortly.",
        );
      } else if (mode === "outlier") {
        void computeOutliers();
      } else if (mode === "surprise" && state.surpriseComputed) {
        globe.setResults(state.surpriseResults, state.topK, mode);
        setStatus(
          `Surprise view \u2014 ${state.surpriseResults.length} patches scored. Brightest = most spatially anomalous.`,
        );
      } else if (mode === "surprise" && surpriseComputing) {
        setStatus(
          "Computing surprise scores\u2026 results will appear shortly.",
        );
      } else if (mode === "surprise") {
        void computeSurprise();
      } else if (mode === "gradient") {
        if (gradientComputing) {
          setStatus("Computing edge scores\u2026 results will appear shortly.");
        } else if (state.gradientResults.length) {
          globe.setResults(state.gradientResults, state.topK, mode);
          setStatus(
            `Edge view \u2014 ${state.gradientResults.length} patches scored. Brightest = strongest boundary.`,
          );
        } else if (state.results.length) {
          void computeGradient();
        } else {
          setStatus(
            "Edge view \u2014 add exemplars first to compute similarity gradients.",
          );
        }
      } else if (mode === "threshold") {
        const filtered = state.results.filter(
          (r) => r.score <= state.threshold,
        );
        globe.setResults(filtered, filtered.length, mode);
        setStatus(
          "Cutoff view \u2014 adjust the threshold slider to filter patches by distance.",
        );
      } else {
        globe.setResults(state.results, state.topK, mode);
        if (state.results.length)
          setStatus(
            `Top-K view \u2014 showing ${Math.min(state.topK, state.results.length)} of ${state.results.length} ranked patches.`,
          );
      }
      updateView();
    });
  });

  e.invertToggle?.addEventListener("click", () => {
    state.invertSearch = !state.invertSearch;
    if (state.baseResults.length) {
      state.results = applyInvert(state.baseResults);
      state.threshold = Infinity;
      if (state.overlayVisible)
        globe.setResults(state.results, state.topK, state.viewMode);
    } else {
      void scoreCandidates();
    }
    updateView();
  });

  e.combineSelect?.addEventListener("change", (ev) => {
    state.combineMethod = (ev.currentTarget as HTMLSelectElement)
      .value as CombineMethod;
    void scoreCandidates();
    updateView();
  });

  e.clearNegativesBtn?.addEventListener("click", clearNegatives);

  // Geocoder search
  e.searchInput?.addEventListener("input", (ev) => {
    const q = (ev.currentTarget as HTMLInputElement).value.trim();
    const timer = getGeocodeTimer();
    if (timer) window.clearTimeout(timer);
    if (!q) {
      renderGeocodeResults([], "", e.searchWrap, e.searchResults, () => {});
      e.searchSpinner?.classList.remove("is-busy");
      return;
    }
    const coord = tryParseLatLng(q);
    const reqId = nextGeocodeReqId();
    e.searchSpinner?.classList.add("is-busy");
    setGeocodeTimer(
      window.setTimeout(async () => {
        try {
          const hits = await fetchGeocode(q);
          if (reqId !== getGeocodeReqId()) return;
          const combined = coord ? [coord, ...hits] : hits;
          renderGeocodeResults(
            combined,
            q,
            e.searchWrap,
            e.searchResults,
            (hit) => {
              flyToHit(hit, globe, setStatus);
              if (e.searchInput) e.searchInput.value = hit.label;
              e.searchWrap?.classList.remove("is-open");
            },
          );
        } catch {
          if (reqId !== getGeocodeReqId()) return;
          renderGeocodeResults(
            coord ? [coord] : [],
            q,
            e.searchWrap,
            e.searchResults,
            (hit) => {
              flyToHit(hit, globe, setStatus);
              if (e.searchInput) e.searchInput.value = hit.label;
              e.searchWrap?.classList.remove("is-open");
            },
          );
        } finally {
          if (reqId === getGeocodeReqId())
            e.searchSpinner?.classList.remove("is-busy");
        }
      }, 320),
    );
  });

  e.searchInput?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      const first =
        e.searchResults?.querySelector<HTMLButtonElement>("button[data-hit]");
      first?.click();
    }
    if (ev.key === "Escape") {
      (ev.currentTarget as HTMLInputElement).blur();
      e.searchWrap?.classList.remove("is-open");
    }
  });

  e.searchInput?.addEventListener("focus", () => {
    if (e.searchInput?.value) e.searchWrap?.classList.add("is-open");
  });

  document.addEventListener("click", (ev) => {
    const t = ev.target as Node;
    if (e.searchWrap && !e.searchWrap.contains(t))
      e.searchWrap.classList.remove("is-open");
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && document.activeElement !== e.searchInput) {
      ev.preventDefault();
      e.searchInput?.focus();
      return;
    }
    if (ev.key !== "Escape") return;
    if (globe.isArmed()) {
      globe.armDraw(false);
      globe.cancelDraft();
      setStatus("Draw disarmed.");
      return;
    }
    if (state.bboxes.length) clearAllRegions();
  });
}

function bootstrap(): void {
  renderShell();
    const mapEl = document.querySelector<HTMLDivElement>("#map");
  if (!mapEl) throw new Error("#map missing");
  globe = new GlobeMap(mapEl, {
    onDrawComplete: ({ bbox, polygon }) => {
      syncPolyDoneBtn();
      void addRegion(bbox, polygon);
    },
    onAoiClick: (lat, lng) => addPositive(lat, lng),
    onNegativeClick: (lat, lng) => addNegative(lat, lng),
    onResultHover: (row) => globe.setPreview(row),
    onResultPick: (row) => {
      const c = centroid(row.bbox);
      addPositive(c.lat, c.lng);
    },
    onPolyVertexChange: () => syncPolyDoneBtn(),
    getBBox: () => state.bboxes[state.bboxes.length - 1]?.bbox ?? null,
    getResults: () => state.results,
    getTopK: () => state.topK,
  });
  wire();
  renderAoiPresets();
  renderInterestingPoints();
  updateView();
  wireTutorial({
    getState: () => state,
    addRegion,
    addPositive,
    addNegative,
    clearAllRegions,
    scoreCandidates,
    updateView,
    setPositives: (points) => {
      state.positivePoints = points;
      globe.setPositives(state.positivePoints);
    },
    globe,
  });
  initAdsb();
}
// ── ADS-B layer init (called from bootstrap after globe is ready) ──────────
let adsbLayer: AdsbLayer;

function initAdsb(): void {
  // Create button immediately (no map required)
  const btn = document.createElement("button");
  btn.id = "adsb-toggle";
  btn.className = "adsb-toggle-btn";
  btn.title = "Toggle live ADS-B air traffic (adsb.lol)";
  btn.innerHTML = '<span class="adsb-icon">✈</span><span class="adsb-label">LIVE</span><span id="adsb-count" class="adsb-count"></span>';
  document.body.appendChild(btn);

  let initialized = false;

  function ensureInit(): boolean {
    if (initialized) return true;
    if (!globe.map.isStyleLoaded()) return false;
    adsbLayer = new AdsbLayer(globe.map, (count) => {
      btn.classList.toggle("is-on", adsbLayer.isEnabled());
      const counter = document.getElementById("adsb-count");
      if (counter) counter.textContent = count > 0 ? String(count) : "";
    });
    adsbLayer.addToMap();
    initialized = true;
    return true;
  }

  btn.addEventListener("click", () => {
    if (!ensureInit()) {
      // Map not ready yet — try again after it loads
      globe.map.once("load", () => {
        ensureInit();
        adsbLayer.setEnabled(true);
        btn.classList.add("is-on");
      });
      return;
    }
    adsbLayer.setEnabled(!adsbLayer.isEnabled());
  });
}

bootstrap();
