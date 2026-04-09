// adsb.ts — adsb.lol live air traffic layer for terrabit
// Fetches aircraft from https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{dist}
// and renders them on the MapLibre globe as animated symbols.

import type maplibregl from "maplibre-gl/dist/maplibre-gl-dev.js";

export interface AdsbAircraft {
  hex: string;
  flight?: string;
  r?: string; // registration
  t?: string; // type
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;  // ground speed knots
  track?: number; // heading degrees
  vert_rate?: number;
  squawk?: string;
  emergency?: string;
  seen_pos?: number;
}

interface AdsbResponse {
  ac: AdsbAircraft[];
  now: number;
  total: number;
}

const ADSB_API = "https://api.adsb.lol/v2";
const REFRESH_MS = 8000;  // refresh every 8 seconds
const FETCH_RADIUS_NM = 250; // nautical miles — global enough for a globe view

export type AdsbUpdateCallback = (count: number) => void;

export class AdsbLayer {
  private map: maplibregl.Map;
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = false;
  private onUpdate: AdsbUpdateCallback;
  private aircraft: AdsbAircraft[] = [];

  constructor(map: maplibregl.Map, onUpdate: AdsbUpdateCallback) {
    this.map = map;
    this.onUpdate = onUpdate;
  }

  /** Add MapLibre sources + layers for aircraft. Called once when map is ready. */
  addToMap(): void {
    if (this.map.getSource("adsb-aircraft")) return;

    this.map.addSource("adsb-aircraft", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Shadow / halo circle
    this.map.addLayer({
      id: "adsb-halo",
      type: "circle",
      source: "adsb-aircraft",
      paint: {
        "circle-radius": 10,
        "circle-color": "#00d4ff",
        "circle-opacity": 0.12,
        "circle-stroke-color": "#00d4ff",
        "circle-stroke-width": 0.5,
        "circle-stroke-opacity": 0.4,
      },
    });

    // Aircraft dot
    this.map.addLayer({
      id: "adsb-dot",
      type: "circle",
      source: "adsb-aircraft",
      paint: {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          0, 2,
          4, 3,
          8, 5,
        ],
        "circle-color": [
          "case",
          ["==", ["get", "emergency"], "general"], "#ff4444",
          ["==", ["get", "emergency"], "squawk7700"], "#ff4444",
          ["==", ["get", "onGround"], true], "#ffaa00",
          "#00d4ff",
        ],
        "circle-stroke-color": "#f3ecd8",
        "circle-stroke-width": 1.2,
        "circle-opacity": 0.92,
      },
    });

    // Direction indicator line from center of aircraft
    this.map.addLayer({
      id: "adsb-track",
      type: "line",
      source: "adsb-aircraft",
      filter: ["has", "trackEnd"],
      paint: {
        "line-color": "#00d4ff",
        "line-width": 1,
        "line-opacity": 0.55,
        "line-dasharray": [2, 2],
      },
    });

    // Label: callsign + altitude
    this.map.addLayer({
      id: "adsb-label",
      type: "symbol",
      source: "adsb-aircraft",
      minzoom: 4,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Regular"],
        "text-size": 10,
        "text-offset": [0, 1.6],
        "text-anchor": "top",
        "text-allow-overlap": false,
        "text-ignore-placement": false,
      },
      paint: {
        "text-color": "rgba(0, 212, 255, 0.9)",
        "text-halo-color": "rgba(15, 10, 8, 0.8)",
        "text-halo-width": 1.2,
      },
    });
  }

  /** Enable or disable the layer + polling. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;

    const visibility = on ? "visible" : "none";
    for (const id of ["adsb-halo", "adsb-dot", "adsb-label", "adsb-track"]) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, "visibility", visibility);
      }
    }

    if (on) {
      void this.fetch();
      this.timer = setInterval(() => void this.fetch(), REFRESH_MS);
    } else {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.clearLayer();
      this.onUpdate(0);
    }
  }

  isEnabled(): boolean { return this.enabled; }

  private clearLayer(): void {
    const src = this.map.getSource("adsb-aircraft") as maplibregl.GeoJSONSource | undefined;
    src?.setData({ type: "FeatureCollection", features: [] });
  }

  private async fetch(): Promise<void> {
    // Use current map center for the API radius query
    const center = this.map.getCenter();
    const lat = center.lat.toFixed(4);
    const lon = center.lng.toFixed(4);
    const url = `${ADSB_API}/lat/${lat}/lon/${lon}/dist/${FETCH_RADIUS_NM}`;

    try {
      const resp = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(7000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as AdsbResponse;
      this.aircraft = (data.ac ?? []).filter(
        (a) => a.lat != null && a.lon != null,
      );
      this.renderLayer();
      this.onUpdate(this.aircraft.length);
    } catch (err) {
      console.warn("[adsb] fetch error:", err);
    }
  }

  private renderLayer(): void {
    const src = this.map.getSource("adsb-aircraft") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const features: GeoJSON.Feature[] = this.aircraft.map((a) => {
      const lon = a.lon!;
      const lat = a.lat!;
      const track = a.track ?? 0;
      const gs = a.gs ?? 0;
      // Project a short line ahead of the aircraft to show direction
      const distDeg = Math.min(gs * 0.0003, 0.5); // ~scaled to speed
      const rad = (track * Math.PI) / 180;
      const endLon = lon + Math.sin(rad) * distDeg;
      const endLat = lat + Math.cos(rad) * distDeg;

      const alt = a.alt_baro === "ground" ? 0 : (a.alt_baro ?? 0);
      const altStr = a.alt_baro === "ground" ? "GND" : `${Math.round(alt / 100) * 100}ft`;
      const callsign = (a.flight ?? a.r ?? a.hex).trim();
      const label = `${callsign}\n${altStr}`;

      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          hex: a.hex,
          callsign,
          label,
          alt,
          speed: gs,
          track: a.track ?? 0,
          onGround: a.alt_baro === "ground",
          emergency: a.emergency ?? "none",
          trackEnd: `${endLon},${endLat}`,
          endLon,
          endLat,
        },
      };
    });

    src.setData({ type: "FeatureCollection", features });
  }

  destroy(): void {
    this.setEnabled(false);
    for (const id of ["adsb-label", "adsb-track", "adsb-dot", "adsb-halo"]) {
      if (this.map.getLayer(id)) this.map.removeLayer(id);
    }
    if (this.map.getSource("adsb-aircraft")) this.map.removeSource("adsb-aircraft");
  }
}
