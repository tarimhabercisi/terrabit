import type { GlobeMap } from "./map";
import type { BBox } from "./types";

export type GeocodeHit = {
  label: string;
  sublabel: string;
  lat: number;
  lng: number;
  bbox?: BBox;
  type: string;
};

let geocodeReqId = 0;
let geocodeTimer: number | null = null;

export async function fetchGeocode(query: string): Promise<GeocodeHit[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "0");
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
    type: string;
    class: string;
    boundingbox?: [string, string, string, string];
  }>;
  return rows.map((r) => {
    const parts = r.display_name.split(",").map((s) => s.trim());
    const label = parts[0] ?? r.display_name;
    const sublabel = parts.slice(1, 4).join(" · ");
    const bb = r.boundingbox
      ? {
          south: Number(r.boundingbox[0]),
          north: Number(r.boundingbox[1]),
          west: Number(r.boundingbox[2]),
          east: Number(r.boundingbox[3]),
        }
      : undefined;
    return {
      label,
      sublabel,
      lat: Number(r.lat),
      lng: Number(r.lon),
      bbox: bb,
      type: `${r.class}:${r.type}`,
    };
  });
}

export function tryParseLatLng(query: string): GeocodeHit | null {
  const m = query
    .trim()
    .match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    sublabel: "coordinate",
    lat,
    lng,
    type: "coord",
  };
}

export function escapeHtml(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function flyToHit(
  hit: GeocodeHit,
  globe: GlobeMap,
  setStatus: (msg: string) => void,
): void {
  if (hit.bbox) {
    globe.fitBounds(hit.bbox, { padding: 120, maxZoom: 11 });
  } else {
    globe.flyToBBox(
      {
        west: hit.lng - 0.05,
        east: hit.lng + 0.05,
        south: hit.lat - 0.05,
        north: hit.lat + 0.05,
      },
      { zoom: 10 },
    );
  }
  setStatus(
    `Flew to ${hit.label}. Shift-drag or hit Draw region to define an AOI.`,
  );
}

export function renderGeocodeResults(
  hits: GeocodeHit[],
  query: string,
  searchWrap: HTMLElement | null,
  searchResults: HTMLUListElement | null,
  onSelect: (hit: GeocodeHit) => void,
): void {
  if (!searchResults || !searchWrap) return;
  if (!query) {
    searchWrap.classList.remove("is-open");
    searchResults.innerHTML = "";
    return;
  }
  if (!hits.length) {
    searchWrap.classList.add("is-open");
    searchResults.innerHTML = `<li class="search-empty">No matches for "${escapeHtml(query)}"</li>`;
    return;
  }
  searchWrap.classList.add("is-open");
  searchResults.innerHTML = hits
    .map(
      (h, i) => `
      <li role="option">
        <button type="button" data-hit="${i}">
          <span class="search-ico">${h.type === "coord" ? "⊹" : "◉"}</span>
          <span class="search-text">
            <span class="search-label">${escapeHtml(h.label)}</span>
            <span class="search-sub">${escapeHtml(h.sublabel || h.type)}</span>
          </span>
        </button>
      </li>`,
    )
    .join("");
  searchResults
    .querySelectorAll<HTMLButtonElement>("button[data-hit]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.hit);
        onSelect(hits[idx]);
      });
    });
}

export function getGeocodeReqId(): number {
  return geocodeReqId;
}

export function nextGeocodeReqId(): number {
  return ++geocodeReqId;
}

export function getGeocodeTimer(): number | null {
  return geocodeTimer;
}

export function setGeocodeTimer(t: number | null): void {
  geocodeTimer = t;
}
