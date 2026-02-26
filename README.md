# terrabit

Binary earth embedding retrieval — find every satellite patch on Earth that looks like a location you point at.

[**Live demo**](https://isaaccorley.github.io/terrabit)

## What it does

terrabit searches a global index of ~5M Sentinel-2 satellite image chips using compact binary embeddings ([Clay v1.5](https://clay.earth)). You draw a region, click an exemplar, and the app ranks every patch by Hamming distance — entirely in-browser using DuckDB-WASM and Web Workers.

**View modes:** Top-K ranked list, continuous heatmap, distance cutoff, outlier detection, spatial surprise, and similarity gradient (edge detection).

**Key features:**
- Globe-wide exemplar placement — click anywhere on Earth, inside or outside your region
- Positive and negative exemplars with combine methods (mean, AND, OR, XOR)
- Invert search to find visual opposites
- GeoParquet export for QGIS, DuckDB, or GeoPandas
- Interactive tutorial with live demo

## Architecture

```
src/
├── main.ts          App orchestration, state, event wiring
├── map.ts           MapLibre globe, drawing, layers
├── scoring-worker.ts  Web Worker: Hamming distance, outlier, surprise, gradient
├── db.ts            DuckDB-WASM init, spatial queries, shard loading
├── geocoder.ts      Nominatim search, coordinate parsing
├── export.ts        GeoParquet writer (Thrift footer injection)
├── tutorial.ts      Interactive walkthrough system
├── presets.ts       Curated AOI regions and discovery points
├── types.ts         Shared type definitions
├── util.ts          Geometry helpers, color interpolation
└── styles.css       Full UI stylesheet (warm espresso palette)
```

**Stack:** TypeScript, Vite, MapLibre GL JS, DuckDB-WASM, Web Workers. No framework — vanilla DOM.

**Data:** Parquet shards hosted on [Source Cooperative](https://source.coop/repositories/geospatialml/terrabit). Each chip has a 256-bit binary embedding from Clay v1.5 and a bounding box. The manifest is queried with DuckDB's spatial extension to find intersecting shards.

## Quick start

```bash
# requires Bun (https://bun.sh)
bun install
bun run dev       # http://localhost:5173
bun run build     # production build → dist/
bun run check     # biome lint + format check
```

Or with Make:

```bash
make dev          # install + dev server
make build        # install + production build
make check        # install + lint
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE) — Copyright 2025 Isaac Corley

Created by [Isaac Corley](https://isaac.earth)
