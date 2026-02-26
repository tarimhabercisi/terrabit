import type { GlobeMap } from "./map";
import type { BBox, ViewMode } from "./types";
import { centroid } from "./util";

export type TutorialCallbacks = {
  getState: () => {
    positivePoints: { length: number }[];
    negativePoints: { length: number }[];
    candidateRows: {
      bbox: BBox;
      embedding: Uint8Array;
      chips_id: string;
    }[];
  };
  addRegion: (bbox: BBox, polygon?: [number, number][]) => Promise<void>;
  addPositive: (lat: number, lng: number) => void;
  addNegative: (lat: number, lng: number) => void;
  clearAllRegions: () => void;
  scoreCandidates: () => Promise<void>;
  updateView: () => void;
  setPositives: (
    points: {
      id: number;
      lat: number;
      lng: number;
      embedding?: Uint8Array;
      chips_id?: string;
    }[],
  ) => void;
  globe: GlobeMap;
};

type TutorialPlacement = "top" | "bottom" | "left" | "right" | "center";

type TutorialStep = {
  target?: string;
  title: string;
  body: string;
  placement?: TutorialPlacement;
  padding?: number;
  onEnter?: () => void;
  onLeave?: () => Promise<void>;
};

const DEMO_BBOX: BBox = {
  west: -98.6,
  east: -98.1,
  south: 38.45,
  north: 38.95,
};
const DEMO_POS_LAT = 38.72;
const DEMO_POS_LNG = -98.34;
const DEMO_NEG_LAT = 38.52;
const DEMO_NEG_LNG = -98.54;

type TutorialState = {
  active: boolean;
  step: number;
};

const tutorialState: TutorialState = { active: false, step: 0 };
let tutorialOverlay: HTMLElement | null = null;
let tutorialCard: HTMLElement | null = null;
let tutorialRaf: number | null = null;
let _tutSimHandles: ReturnType<typeof setTimeout>[] = [];
let _cb: TutorialCallbacks;

function tutSimDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const h = setTimeout(resolve, ms);
    _tutSimHandles.push(h);
  });
}

function tutCancelSim(): void {
  _tutSimHandles.forEach(clearTimeout);
  _tutSimHandles = [];
}

async function tutSimulateDraw(bbox: BBox, durationMs = 1400): Promise<void> {
  const steps = 32;
  const interval = durationMs / steps;
  for (let i = 1; i <= steps; i++) {
    if (!tutorialState.active) return;
    const t = i / steps;
    _cb.globe.setDraft({
      west: bbox.west,
      east: bbox.west + (bbox.east - bbox.west) * t,
      south: bbox.north - (bbox.north - bbox.south) * t,
      north: bbox.north,
    });
    await tutSimDelay(interval);
  }
  _cb.globe.setDraft(null);
  await _cb.addRegion(bbox);
}

function tutShowRipple(lat: number, lng: number, color: string): void {
  const pt = _cb.globe.map.project([lng, lat]);
  const container = _cb.globe.map.getCanvasContainer();
  const cRect = container.getBoundingClientRect();
  const ripple = document.createElement("div");
  ripple.className = "tut-ripple";
  ripple.style.left = `${cRect.left + pt.x}px`;
  ripple.style.top = `${cRect.top + pt.y}px`;
  ripple.style.setProperty("--tut-ripple-color", color);
  document.body.appendChild(ripple);
  setTimeout(() => ripple.remove(), 900);
}

async function tutSimulatePositive(lat: number, lng: number): Promise<void> {
  tutShowRipple(lat, lng, "#c74633");
  await tutSimDelay(180);
  _cb.addPositive(lat, lng);
}

async function tutSimulateExternalPositive(): Promise<void> {
  const st = _cb.getState();
  const candidates = st.candidateRows;
  if (!candidates.length) return;
  const sorted = candidates.slice().sort((a, b) => {
    const latA = (a.bbox.north + a.bbox.south) / 2;
    const latB = (b.bbox.north + b.bbox.south) / 2;
    return Math.abs(DEMO_BBOX.north - latA) - Math.abs(DEMO_BBOX.north - latB);
  });
  const pick = sorted[0];
  const c = centroid(pick.bbox);
  const markerLat = DEMO_BBOX.north + 0.08;
  const markerLng = c.lng;
  tutShowRipple(markerLat, markerLng, "#c74633");
  await tutSimDelay(180);
  const id = st.positivePoints.length + 1;
  const points = [
    ...st.positivePoints.map((p, i) => ({ ...p, id: i + 1 })),
    {
      id,
      lat: markerLat,
      lng: markerLng,
      embedding: pick.embedding,
      chips_id: pick.chips_id,
    },
  ];
  _cb.setPositives(points);
  void _cb.scoreCandidates();
  _cb.updateView();
}

async function tutSimulateNegative(lat: number, lng: number): Promise<void> {
  tutShowRipple(lat, lng, "#3b82f6");
  await tutSimDelay(180);
  _cb.addNegative(lat, lng);
}

function tutWaitForData(maxWaitMs = 35000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxWaitMs;
    const poll = () => {
      if (_cb.getState().candidateRows.length > 0) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      const h = setTimeout(poll, 300);
      _tutSimHandles.push(h);
    };
    poll();
  });
}

function tutSetViewMode(mode: ViewMode): void {
  const tab = document.querySelector<HTMLButtonElement>(
    `.view-tab[data-view="${mode}"]`,
  );
  tab?.click();
}

function buildTutorialSteps(): TutorialStep[] {
  return [
    {
      title: "Welcome to terrabit",
      body: "terrabit finds every satellite patch on Earth that looks like a location you point at \u2014 powered by compact binary embeddings. Watch this live demo to see how it works.",
      placement: "center",
    },
    {
      title: "Step 1 \u2014 fly to a region",
      body: "We\u2019re zooming to the agricultural plains of central Kansas \u2014 a compact, high-contrast area that loads in seconds. Watch as terrabit draws a region and loads the embeddings.",
      placement: "center",
      onEnter: () => {
        _cb.globe.map.flyTo({
          center: [-98.35, 38.7],
          zoom: 9,
          duration: 1600,
        });
        setTimeout(() => {
          void tutSimulateDraw(DEMO_BBOX);
        }, 1800);
      },
      onLeave: async () => {
        tutCancelSim();
        if (!_cb.getState().candidateRows.length)
          await _cb.addRegion(DEMO_BBOX);
      },
    },
    {
      target: "#positive-list",
      title: "Step 2 \u2014 place a positive exemplar",
      body: "Patches are loaded. We click a farm field <em>inside</em> the region, then a second point just <em>outside</em> it \u2014 <strong>exemplars can go anywhere on the globe</strong>. terrabit fetches the external embedding on the fly and scores every patch by binary Hamming distance.",
      placement: "right",
      padding: 8,
      onEnter: () => {
        if (_cb.getState().positivePoints.length > 0) return;
        const stepAtEnter = tutorialState.step;
        void tutWaitForData().then(async (ready) => {
          if (
            !ready ||
            !tutorialState.active ||
            tutorialState.step !== stepAtEnter
          )
            return;
          await tutSimulatePositive(DEMO_POS_LAT, DEMO_POS_LNG);
          await tutSimDelay(2200);
          if (!tutorialState.active || tutorialState.step !== stepAtEnter)
            return;
          await tutSimulateExternalPositive();
        });
      },
      onLeave: async () => {
        tutCancelSim();
        if (_cb.getState().positivePoints.length === 0) {
          const ready = await tutWaitForData(5000);
          if (ready) {
            await tutSimulatePositive(DEMO_POS_LAT, DEMO_POS_LNG);
            await tutSimulateExternalPositive();
          }
        }
      },
    },
    {
      target: "#negative-section",
      title: "Step 3 \u2014 add a negative to refine",
      body: "We\u2019re right-clicking a different land type as a negative exemplar. Negatives push <em>away</em> from that pattern \u2014 results immediately shift to emphasize the positive and suppress the negative.",
      placement: "right",
      padding: 8,
      onEnter: () => {
        if (_cb.getState().negativePoints.length > 0) return;
        void tutSimulateNegative(DEMO_NEG_LAT, DEMO_NEG_LNG);
      },
      onLeave: async () => {
        tutCancelSim();
        if (_cb.getState().negativePoints.length === 0) {
          await tutSimulateNegative(DEMO_NEG_LAT, DEMO_NEG_LNG);
        }
      },
    },
    {
      target: ".view-toggle",
      title: "Step 4 \u2014 explore view modes",
      body: "Watch as terrabit cycles through every view: <strong>Top-K</strong> ranks closest matches \u00b7 <strong>Heat</strong> paints a continuous similarity surface \u00b7 <strong>Cutoff</strong> filters by distance \u00b7 <strong>Outlier</strong> finds unique patches \u00b7 <strong>Surprise</strong> spots spatial anomalies \u00b7 <strong>Edge</strong> traces similarity boundaries.",
      placement: "right",
      padding: 10,
      onEnter: () => {
        const stepAtEnter = tutorialState.step;
        const modes: ViewMode[] = [
          "topk",
          "heatmap",
          "threshold",
          "outlier",
          "surprise",
          "gradient",
        ];
        const cycle = async (): Promise<void> => {
          for (const mode of modes) {
            if (!tutorialState.active || tutorialState.step !== stepAtEnter)
              return;
            tutSetViewMode(mode);
            await tutSimDelay(1100);
          }
          if (!tutorialState.active || tutorialState.step !== stepAtEnter)
            return;
          void cycle();
        };
        void tutSimDelay(600).then(() => {
          if (!tutorialState.active || tutorialState.step !== stepAtEnter)
            return;
          void cycle();
        });
      },
    },
    {
      title: "You\u2019re ready",
      body: "Click anywhere on the globe to add your own exemplars. Add more regions, flip <strong>Invert</strong> to find opposites, or explore <strong>Outlier</strong>, <strong>Surprise</strong>, and <strong>Edge</strong> views. Export results as GeoParquet for QGIS, DuckDB, or GeoPandas.",
      placement: "center",
    },
  ];
}

let TUTORIAL_STEPS: TutorialStep[] = [];

function isMobileViewport(): boolean {
  return window.innerWidth <= 600;
}

function tutorialGetEl(): { overlay: HTMLElement; card: HTMLElement } {
  if (!tutorialOverlay) {
    tutorialOverlay = document.createElement("div");
    tutorialOverlay.className = "tut-overlay";
    tutorialOverlay.id = "tut-overlay";
    document.body.appendChild(tutorialOverlay);
  }
  if (!tutorialCard) {
    tutorialCard = document.createElement("div");
    tutorialCard.className = "tut-card";
    tutorialCard.id = "tut-card";
    document.body.appendChild(tutorialCard);
  }
  return { overlay: tutorialOverlay, card: tutorialCard };
}

function tutorialPositionCard(
  card: HTMLElement,
  target: Element | null,
  placement: TutorialPlacement,
  padding: number,
): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cw = card.offsetWidth || 320;
  const ch = card.offsetHeight || 200;
  const margin = 18;

  if (!target || placement === "center" || isMobileViewport()) {
    card.style.left = `${(vw - cw) / 2}px`;
    card.style.top = `${Math.max(margin, (vh - ch) / 3)}px`;
    return;
  }

  const r = target.getBoundingClientRect();
  const pad = padding;
  let left = 0;
  let top = 0;

  if (placement === "right") {
    left = r.right + pad + margin;
    top = r.top + r.height / 2 - ch / 2;
  } else if (placement === "left") {
    left = r.left - pad - cw - margin;
    top = r.top + r.height / 2 - ch / 2;
  } else if (placement === "bottom") {
    left = r.left + r.width / 2 - cw / 2;
    top = r.bottom + pad + margin;
  } else {
    left = r.left + r.width / 2 - cw / 2;
    top = r.top - pad - ch - margin;
  }

  left = Math.max(margin, Math.min(left, vw - cw - margin));
  top = Math.max(margin, Math.min(top, vh - ch - margin));

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function tutorialPaintShadowOverlay(
  overlay: HTMLElement,
  target: Element | null,
  padding: number,
): void {
  if (!target) {
    overlay.style.removeProperty("background");
    overlay.style.setProperty("--tut-shadow-inset", "none");
    overlay.classList.remove("has-spotlight");
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = padding;
  const rx = Math.max(0, r.left - pad);
  const ry = Math.max(0, r.top - pad);
  const rw = r.width + pad * 2;
  const rh = r.height + pad * 2;
  overlay.style.setProperty("--tut-spot-x", `${rx}px`);
  overlay.style.setProperty("--tut-spot-y", `${ry}px`);
  overlay.style.setProperty("--tut-spot-w", `${rw}px`);
  overlay.style.setProperty("--tut-spot-h", `${rh}px`);
  overlay.classList.add("has-spotlight");
}

function tutorialRender(): void {
  const { overlay, card } = tutorialGetEl();
  const step = TUTORIAL_STEPS[tutorialState.step];
  if (!step) return;
  step.onEnter?.();

  const target = step.target ? document.querySelector(step.target) : null;
  const placement = step.placement ?? "bottom";
  const padding = step.padding ?? 10;
  const mobile = isMobileViewport();
  const isCenter = placement === "center" || !target || mobile;
  const total = TUTORIAL_STEPS.length;
  const idx = tutorialState.step;

  tutorialPaintShadowOverlay(overlay, isCenter ? null : target, padding);

  const dots = Array.from(
    { length: total },
    (_, i) => `<span class="tut-dot${i === idx ? " is-active" : ""}"></span>`,
  ).join("");

  card.innerHTML = `
    <button class="tut-dismiss" aria-label="Close tutorial" id="tut-close">\u2715</button>
    <p class="tut-step-label">${idx + 1} / ${total}</p>
    <h3 class="tut-title">${step.title}</h3>
    <p class="tut-body">${step.body}</p>
    <div class="tut-dots">${dots}</div>
    <div class="tut-actions">
      <button class="tut-btn tut-btn-ghost" id="tut-skip" type="button">Skip tour</button>
      <div class="tut-nav">
        ${idx > 0 ? `<button class="tut-btn tut-btn-secondary" id="tut-back" type="button">\u2190 Back</button>` : ""}
        ${
          idx < total - 1
            ? `<button class="tut-btn tut-btn-primary" id="tut-next" type="button">Next \u2192</button>`
            : `<button class="tut-btn tut-btn-primary" id="tut-done" type="button">Get started</button>`
        }
      </div>
    </div>
  `;

  void overlay.offsetWidth;
  void card.offsetWidth;

  overlay.classList.add("is-active");
  card.classList.add("is-active");

  requestAnimationFrame(() => {
    tutorialPositionCard(card, isCenter ? null : target, placement, padding);
  });

  card.querySelector("#tut-close")?.addEventListener("click", tutorialStop);
  card.querySelector("#tut-skip")?.addEventListener("click", tutorialStop);
  card
    .querySelector("#tut-back")
    ?.addEventListener("click", () => tutorialGo(idx - 1));
  card
    .querySelector("#tut-next")
    ?.addEventListener("click", () => tutorialGo(idx + 1));
  card.querySelector("#tut-done")?.addEventListener("click", tutorialStop);
}

async function tutorialGo(targetStep: number): Promise<void> {
  const currentStep = tutorialState.step;
  if (targetStep > currentStep) {
    const current = TUTORIAL_STEPS[currentStep];
    if (current?.onLeave) {
      const nextBtn = document.querySelector<HTMLButtonElement>("#tut-next");
      if (nextBtn) nextBtn.disabled = true;
      await current.onLeave();
      if (nextBtn) nextBtn.disabled = false;
    }
  }
  tutorialState.step = Math.max(
    0,
    Math.min(targetStep, TUTORIAL_STEPS.length - 1),
  );
  const card = document.querySelector<HTMLElement>("#tut-card");
  const overlay = document.querySelector<HTMLElement>("#tut-overlay");
  if (card) {
    card.classList.add("is-transitioning");
    if (overlay) overlay.classList.add("is-transitioning");
    if (tutorialRaf) cancelAnimationFrame(tutorialRaf);
    tutorialRaf = requestAnimationFrame(() => {
      tutorialRaf = requestAnimationFrame(() => {
        card.classList.remove("is-transitioning");
        if (overlay) overlay.classList.remove("is-transitioning");
        tutorialRender();
      });
    });
  } else {
    tutorialRender();
  }
}

function tutorialStart(): void {
  tutCancelSim();
  _cb.clearAllRegions();
  tutorialState.active = true;
  tutorialState.step = 0;
  tutorialRender();
}

function tutorialStop(): void {
  tutCancelSim();
  tutorialState.active = false;
  const overlay = document.querySelector<HTMLElement>("#tut-overlay");
  const card = document.querySelector<HTMLElement>("#tut-card");
  if (overlay)
    overlay.classList.remove("is-active", "has-spotlight", "is-transitioning");
  if (card) card.classList.remove("is-active", "is-transitioning");
  if (_cb.getState().candidateRows.length === 0) _cb.clearAllRegions();
}

export function wireTutorial(cb: TutorialCallbacks): void {
  _cb = cb;
  TUTORIAL_STEPS = buildTutorialSteps();

  const btn = document.querySelector<HTMLButtonElement>("#tutorial-trigger");
  btn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (tutorialState.active) tutorialStop();
    else tutorialStart();
  });

  setTimeout(tutorialStart, 900);

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && tutorialState.active) tutorialStop();
    if (ev.key === "Enter" && tutorialState.active) {
      const next = tutorialState.step + 1;
      if (next < TUTORIAL_STEPS.length) tutorialGo(next);
      else tutorialStop();
    }
  });

  document.addEventListener("click", (ev) => {
    if (!tutorialState.active) return;
    const overlay = document.querySelector<HTMLElement>("#tut-overlay");
    const card = document.querySelector<HTMLElement>("#tut-card");
    const t = ev.target as Node;
    if (overlay && overlay === t) {
      const next = tutorialState.step + 1;
      if (next < TUTORIAL_STEPS.length) tutorialGo(next);
      else tutorialStop();
    }
    if (card?.contains(t)) return;
  });
}
