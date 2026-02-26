# Contributing to terrabit

## Setup

```bash
bun install
bun run dev
```

Requires [Bun](https://bun.sh) v1.3+. Version pinned in `mise.toml`.

## Development workflow

```bash
bun run dev       # Vite dev server with HMR
bun run check     # Lint + format check (must pass before PR)
bun run format    # Auto-fix lint + formatting
bun run build     # Production build
```

## Code style

- **Formatter/linter:** [Biome](https://biomejs.dev/) — config in `biome.json`
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) (`feat|fix|refactor|ci|style|perf|test|docs|chore`)
- **No framework** — vanilla TypeScript + DOM. Keep it that way.
- **File size:** aim for <500 LOC per file. Split when a file grows beyond that.

## Pull requests

1. Fork and branch from `main`
2. Run `bun run check` — CI will gate on this
3. Keep PRs focused — one concern per PR
4. Write a clear description of what changed and why

## Architecture notes

- **State** is a module-scoped singleton in `main.ts` — no global mutable state outside that file
- **Scoring** runs in a dedicated Web Worker (`scoring-worker.ts`) to avoid blocking the UI
- **DuckDB-WASM** handles all Parquet I/O and spatial filtering via SQL
- **MapLibre** renders the globe with GeoJSON sources updated reactively
- **No build-time data** — all data is fetched at runtime from Source Cooperative

## Adding AOI presets or discovery points

Edit `src/presets.ts`. Each entry needs a `name`, `tag`, and `bbox` (west/south/east/north in EPSG:4326).
