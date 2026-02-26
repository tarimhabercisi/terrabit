import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWorkerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWorkerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";

import type { BBox, CandidateRow } from "./types";
import { normalizeBBox, normalizeEmbedding } from "./util";

export const MANIFEST_URL =
  "https://data.source.coop/geospatialml/terrabit/clay-v1_5-binary-sentinel-2/manifest.parquet";

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdbWasmMvp, mainWorker: duckdbWorkerMvp },
  eh: { mainModule: duckdbWasmEh, mainWorker: duckdbWorkerEh },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function resolveShardUrl(relativePath: string): string {
  try {
    return new URL(relativePath, MANIFEST_URL).toString();
  } catch {
    return relativePath;
  }
}

function bboxToWKT(b: BBox): string {
  return `POLYGON((${b.west} ${b.south},${b.east} ${b.south},${b.east} ${b.north},${b.west} ${b.north},${b.west} ${b.south}))`;
}

function ringToWKT(ring: [number, number][]): string {
  return `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(",")}))`;
}

export function buildManifestQuery(
  bbox: BBox,
  polygon?: [number, number][],
): string {
  const wkt = polygon ? ringToWKT(polygon) : bboxToWKT(bbox);
  return `
    SELECT path, rows, xmin, ymin, xmax, ymax, year
    FROM read_parquet(${sqlString(MANIFEST_URL)})
    WHERE ST_Intersects(
      ST_GeomFromText('${wkt}'),
      ST_MakeEnvelope(xmin, ymin, xmax, ymax)
    )
    ORDER BY rows DESC, path ASC
  `.trim();
}

export function buildShardQuery(
  shardUrl: string,
  bbox: BBox,
  polygon?: [number, number][],
): string {
  const wkt = polygon ? ringToWKT(polygon) : bboxToWKT(bbox);
  return `
    SELECT chips_id, bbox, embedding
    FROM read_parquet(${sqlString(shardUrl)})
    WHERE ST_Intersects(
      ST_GeomFromText('${wkt}'),
      ST_MakeEnvelope(bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax)
    )
  `.trim();
}

export async function fetchShardCandidates(
  db: duckdb.AsyncDuckDB,
  shardUrl: string,
  bbox: BBox,
  polygon?: [number, number][],
): Promise<CandidateRow[]> {
  const conn = await db.connect();
  try {
    const result = await conn.query(buildShardQuery(shardUrl, bbox, polygon));
    const rows = result.toArray() as Array<{
      chips_id: string;
      bbox: { xmin: number; ymin: number; xmax: number; ymax: number };
      embedding: unknown;
    }>;
    return rows.map((row) => ({
      chips_id: row.chips_id,
      bbox: normalizeBBox(row.bbox),
      embedding: normalizeEmbedding(row.embedding),
      shard_path: shardUrl,
    }));
  } finally {
    await conn.close();
  }
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = {
            status: "fulfilled",
            value: await worker(items[i], i),
          };
        } catch (err) {
          results[i] = { status: "rejected", reason: err };
        }
      }
    },
  );
  await Promise.all(runners);
  return results;
}

async function instantiateDuckDB(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
  if (!bundle.mainWorker) throw new Error("DuckDB bundle missing worker");
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    const conn = await db.connect();
    await conn.query(
      "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;",
    );
    await conn.close();
    return db;
  } catch (err) {
    worker.terminate();
    throw err;
  }
}

export function getDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (!dbPromise) dbPromise = instantiateDuckDB();
  return dbPromise;
}
