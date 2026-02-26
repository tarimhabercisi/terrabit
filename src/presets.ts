import type { BBox } from "./types";

export type AoiPreset = { name: string; tag: string; bbox: BBox };

export const AOI_PRESETS: AoiPreset[] = [
  {
    name: "Malé Atoll",
    tag: "coral atoll",
    bbox: { west: 73.35, south: 4.05, east: 73.7, north: 4.35 },
  },
  {
    name: "Rotterdam",
    tag: "port",
    bbox: { west: 3.85, south: 51.85, east: 4.35, north: 52.05 },
  },
  {
    name: "Atacama",
    tag: "lithium mines",
    bbox: { west: -68.6, south: -23.8, east: -67.8, north: -23.1 },
  },
  {
    name: "Center pivots",
    tag: "agriculture",
    bbox: { west: 37.2, south: 29.0, east: 39.0, north: 30.2 },
  },
  {
    name: "Palm Islands",
    tag: "coastal eng.",
    bbox: { west: 54.95, south: 25.05, east: 55.25, north: 25.2 },
  },
  {
    name: "Bhadla Solar",
    tag: "solar farm",
    bbox: { west: 71.6, south: 27.3, east: 72.1, north: 27.65 },
  },
  {
    name: "Rondônia",
    tag: "deforestation",
    bbox: { west: -63.5, south: -11.0, east: -62.5, north: -10.0 },
  },
  {
    name: "Kansas Grid",
    tag: "cropland",
    bbox: { west: -101.0, south: 37.6, east: -100.0, north: 38.4 },
  },
  {
    name: "Hartsfield ATL",
    tag: "airport",
    bbox: { west: -84.55, south: 33.55, east: -84.35, north: 33.7 },
  },
  {
    name: "Pilbara Mines",
    tag: "mining",
    bbox: { west: 117.6, south: -22.8, east: 118.8, north: -21.8 },
  },
  {
    name: "Venice Lagoon",
    tag: "lagoon",
    bbox: { west: 12.15, south: 45.3, east: 12.55, north: 45.55 },
  },
  {
    name: "Vatnajökull",
    tag: "glacier",
    bbox: { west: -17.2, south: 64.1, east: -16.2, north: 64.6 },
  },
  {
    name: "Ganges Delta",
    tag: "river delta",
    bbox: { west: 89.0, south: 21.6, east: 90.0, north: 22.4 },
  },
  {
    name: "Yellowstone",
    tag: "caldera",
    bbox: { west: -111.0, south: 44.3, east: -110.0, north: 44.85 },
  },
  {
    name: "Mekong Delta",
    tag: "rice paddy",
    bbox: { west: 105.6, south: 9.7, east: 106.4, north: 10.3 },
  },
  {
    name: "Horns Rev",
    tag: "wind farm",
    bbox: { west: 7.5, south: 55.4, east: 8.2, north: 55.8 },
  },
  {
    name: "Salar de Uyuni",
    tag: "salt flat",
    bbox: { west: -68.0, south: -20.6, east: -67.0, north: -19.8 },
  },
  {
    name: "Tokyo Bay",
    tag: "megacity",
    bbox: { west: 139.6, south: 35.55, east: 140.0, north: 35.8 },
  },
  {
    name: "Outer Banks",
    tag: "barrier island",
    bbox: { west: -76.0, south: 35.0, east: -75.3, north: 35.7 },
  },
  {
    name: "Bali Terraces",
    tag: "terraced ag.",
    bbox: { west: 115.15, south: -8.55, east: 115.55, north: -8.2 },
  },
  {
    name: "Borneo Palm",
    tag: "oil palm",
    bbox: { west: 109.5, south: 0.6, east: 110.5, north: 1.4 },
  },
  {
    name: "Nile Valley",
    tag: "irrigated strip",
    bbox: { west: 31.0, south: 25.5, east: 31.8, north: 26.3 },
  },
  {
    name: "Las Vegas",
    tag: "desert city",
    bbox: { west: -115.35, south: 36.0, east: -114.95, north: 36.3 },
  },
  {
    name: "Namib Dunes",
    tag: "sand dunes",
    bbox: { west: 14.8, south: -24.8, east: 15.6, north: -24.0 },
  },
  {
    name: "Three Gorges",
    tag: "dam/reservoir",
    bbox: { west: 110.8, south: 30.7, east: 111.4, north: 31.1 },
  },
  {
    name: "Svalbard",
    tag: "arctic coast",
    bbox: { west: 14.5, south: 78.0, east: 16.5, north: 78.5 },
  },
  {
    name: "Aral Sea",
    tag: "dried lake",
    bbox: { west: 58.0, south: 44.5, east: 59.5, north: 45.5 },
  },
  {
    name: "Great Reef",
    tag: "coral reef",
    bbox: { west: 145.6, south: -16.8, east: 146.4, north: -16.2 },
  },
  {
    name: "Brasília",
    tag: "planned city",
    bbox: { west: -48.0, south: -15.9, east: -47.7, north: -15.65 },
  },
  {
    name: "Suez Canal",
    tag: "shipping canal",
    bbox: { west: 32.2, south: 30.3, east: 32.6, north: 31.0 },
  },
  {
    name: "Iceland Lava",
    tag: "lava field",
    bbox: { west: -22.5, south: 63.7, east: -21.5, north: 64.1 },
  },
  {
    name: "Saharan Oasis",
    tag: "oasis",
    bbox: { west: 8.8, south: 32.3, east: 9.4, north: 32.7 },
  },
  {
    name: "Amsterdam",
    tag: "canal city",
    bbox: { west: 4.8, south: 52.33, east: 5.0, north: 52.42 },
  },
  {
    name: "Everglades",
    tag: "wetland",
    bbox: { west: -81.0, south: 25.3, east: -80.3, north: 25.8 },
  },
  {
    name: "Danakil",
    tag: "salt/sulfur",
    bbox: { west: 40.2, south: 14.1, east: 40.7, north: 14.5 },
  },
  {
    name: "Singapore",
    tag: "island city",
    bbox: { west: 103.6, south: 1.2, east: 104.05, north: 1.45 },
  },
  {
    name: "Fjords Norway",
    tag: "fjord",
    bbox: { west: 6.5, south: 61.5, east: 7.5, north: 62.0 },
  },
  {
    name: "Mount Etna",
    tag: "volcano",
    bbox: { west: 14.85, south: 37.65, east: 15.15, north: 37.85 },
  },
  {
    name: "Cape Town",
    tag: "coastal city",
    bbox: { west: 18.3, south: -34.1, east: 18.7, north: -33.85 },
  },
];

export type InterestingCategory =
  | "temporal"
  | "outlier"
  | "cluster"
  | "entropy";

export type InterestingPoint = {
  name: string;
  tag: string;
  bbox: BBox;
  category: InterestingCategory;
};

export const INTERESTING_POINTS: InterestingPoint[] = [
  {
    name: "Moosonee",
    tag: "boreal Δ",
    category: "temporal",
    bbox: { west: -80.98, south: 59.82, east: -80.38, north: 60.42 },
  },
  {
    name: "Comoros",
    tag: "tropical Δ",
    category: "temporal",
    bbox: { west: 43.72, south: -11.21, east: 44.32, north: -10.61 },
  },
  {
    name: "SE Tasmania",
    tag: "island Δ",
    category: "temporal",
    bbox: { west: 149.03, south: -40.87, east: 149.63, north: -40.27 },
  },
  {
    name: "Krasnoyarsk",
    tag: "isolated",
    category: "outlier",
    bbox: { west: 92.71, south: 60.35, east: 93.31, north: 60.95 },
  },
  {
    name: "W Siberia",
    tag: "isolated",
    category: "outlier",
    bbox: { west: 77.54, south: 56.71, east: 78.14, north: 57.31 },
  },
  {
    name: "Dead Sea",
    tag: "isolated",
    category: "outlier",
    bbox: { west: 35.14, south: 30.82, east: 35.74, north: 31.42 },
  },
  {
    name: "Thar Desert",
    tag: "isolated",
    category: "outlier",
    bbox: { west: 71.7, south: 26.5, east: 72.3, north: 27.1 },
  },
  {
    name: "Iceland Lava",
    tag: "isolated",
    category: "outlier",
    bbox: { west: -17.52, south: 63.52, east: -16.92, north: 64.12 },
  },
  {
    name: "Mauritanian Erg",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: -7.41, south: 19.79, east: -6.81, north: 20.39 },
  },
  {
    name: "St. Elias Mtn",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: -139.26, south: 59.13, east: -138.66, north: 59.73 },
  },
  {
    name: "Karakum Desert",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 61.0, south: 38.41, east: 61.6, north: 39.01 },
  },
  {
    name: "Amazon",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: -64.66, south: -5.83, east: -64.06, north: -5.23 },
  },
  {
    name: "Lake Turkana",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 34.82, south: 2.31, east: 35.42, north: 2.91 },
  },
  {
    name: "Richat Structure",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: -11.7, south: 20.8, east: -11.1, north: 21.4 },
  },
  {
    name: "Salar de Uyuni",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: -68.0, south: -20.6, east: -67.4, north: -20.0 },
  },
  {
    name: "Namib Sand Sea",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 14.7, south: -25.0, east: 15.3, north: -24.4 },
  },
  {
    name: "Sundarbans",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 88.9, south: 21.6, east: 89.5, north: 22.2 },
  },
  {
    name: "Tibetan Plateau",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 85.7, south: 30.2, east: 86.3, north: 30.8 },
  },
  {
    name: "Chott el Djerid",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 8.2, south: 33.5, east: 8.8, north: 34.1 },
  },
  {
    name: "Danakil Depression",
    tag: "rare surface",
    category: "cluster",
    bbox: { west: 40.5, south: 13.8, east: 41.1, north: 14.4 },
  },
  {
    name: "Bering Sea",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: -170.79, south: 63.2, east: -170.19, north: 63.8 },
  },
  {
    name: "Yamal",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 63.22, south: 76.19, east: 63.82, north: 76.79 },
  },
  {
    name: "Adelaide Hills",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 138.2, south: -35.79, east: 138.8, north: -35.19 },
  },
  {
    name: "Okavango Delta",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 22.6, south: -19.8, east: 23.2, north: -19.2 },
  },
  {
    name: "Inner Niger Delta",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: -4.5, south: 14.7, east: -3.9, north: 15.3 },
  },
  {
    name: "Pantanal",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: -57.8, south: -17.8, east: -57.2, north: -17.2 },
  },
  {
    name: "Mekong Delta",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 105.2, south: 10.0, east: 105.8, north: 10.6 },
  },
  {
    name: "Irrawaddy Delta",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 95.0, south: 15.5, east: 95.6, north: 16.1 },
  },
  {
    name: "Lena Delta",
    tag: "high entropy",
    category: "entropy",
    bbox: { west: 126.2, south: 72.4, east: 126.8, north: 73.0 },
  },
];
