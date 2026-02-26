import { getDuckDB, sqlString } from "./db";
import type { PositiveMatch, RankedRow } from "./types";
import { centroid } from "./util";

function wkbPointHex(lng: number, lat: number): string {
  const buf = new ArrayBuffer(21);
  const dv = new DataView(buf);
  dv.setUint8(0, 1);
  dv.setUint32(1, 1, true);
  dv.setFloat64(5, lng, true);
  dv.setFloat64(13, lat, true);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function thriftStrBytes(s: string): Uint8Array {
  const payload = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setInt32(0, payload.length, false);
  return concatBytes([len, payload]);
}

function thriftKVStruct(key: string, value: string): Uint8Array {
  return concatBytes([
    new Uint8Array([0x0b, 0x00, 0x01]),
    thriftStrBytes(key),
    new Uint8Array([0x0b, 0x00, 0x02]),
    thriftStrBytes(value),
    new Uint8Array([0x00]),
  ]);
}

function thriftKVField(structs: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(8);
  header[0] = 0x0f;
  header[1] = 0x00;
  header[2] = 0x05;
  header[3] = 0x0c;
  new DataView(header.buffer).setInt32(4, structs.length, false);
  return concatBytes([header, ...structs]);
}

function findThriftKVMeta(
  footer: Uint8Array,
): { countPos: number; dataEnd: number; count: number } | null {
  const dv = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  let pos = 0;

  function skipValue(type: number): void {
    if (type === 2 || type === 3) {
      pos += 1;
    } else if (type === 4) {
      pos += 8;
    } else if (type === 6) {
      pos += 2;
    } else if (type === 8) {
      pos += 4;
    } else if (type === 10) {
      pos += 8;
    } else if (type === 11) {
      pos += 4 + dv.getInt32(pos, false);
    } else if (type === 12) {
      let t: number;
      while ((t = footer[pos++]) !== 0) {
        pos += 2;
        skipValue(t);
      }
    } else if (type === 13) {
      const kt = footer[pos++];
      const vt = footer[pos++];
      const n = dv.getInt32(pos, false);
      pos += 4;
      for (let i = 0; i < n; i++) {
        skipValue(kt);
        skipValue(vt);
      }
    } else if (type === 14 || type === 15) {
      const et = footer[pos++];
      const n = dv.getInt32(pos, false);
      pos += 4;
      for (let i = 0; i < n; i++) skipValue(et);
    }
  }

  while (pos < footer.length) {
    const type = footer[pos++];
    if (type === 0) return null;
    const fieldId = dv.getInt16(pos, false);
    pos += 2;
    if (fieldId === 5 && type === 0x0f) {
      pos += 1;
      const countPos = pos;
      const count = dv.getInt32(pos, false);
      pos += 4;
      for (let i = 0; i < count; i++) skipValue(0x0c);
      return { countPos, dataEnd: pos, count };
    }
    skipValue(type);
  }
  return null;
}

function injectGeoMeta(footer: Uint8Array, geoJson: string): Uint8Array {
  const geo = thriftKVStruct("geo", geoJson);
  const meta = findThriftKVMeta(footer);

  if (meta) {
    const { countPos, dataEnd, count } = meta;
    const newCount = new Uint8Array(4);
    new DataView(newCount.buffer).setInt32(0, count + 1, false);
    return concatBytes([
      footer.slice(0, countPos),
      newCount,
      footer.slice(countPos + 4, dataEnd),
      geo,
      footer.slice(dataEnd),
    ]);
  }
  return concatBytes([
    footer.slice(0, footer.length - 1),
    thriftKVField([geo]),
    new Uint8Array([0x00]),
  ]);
}

function makeGeoParquet(buf: Uint8Array, geoJson: string): Uint8Array {
  const n = buf.length;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const footerLen = dv.getInt32(n - 8, true);
  const footerStart = n - 8 - footerLen;

  const prefix = buf.slice(0, footerStart);
  const footer = buf.slice(footerStart, footerStart + footerLen);
  const newFooter = injectGeoMeta(footer, geoJson);

  const newLen = new Uint8Array(4);
  new DataView(newLen.buffer).setInt32(0, newFooter.length, true);
  return concatBytes([
    prefix,
    newFooter,
    newLen,
    new Uint8Array([0x50, 0x41, 0x52, 0x31]),
  ]);
}

const GEO_META = JSON.stringify({
  version: "1.0.0",
  primary_column: "geometry",
  columns: { geometry: { encoding: "WKB", geometry_types: ["Point"] } },
});

export async function exportGeoParquet(
  positiveMatches: PositiveMatch[],
  results: RankedRow[],
  topK: number,
  viewMode: string,
  setStatus: (msg: string) => void,
): Promise<void> {
  const exemplars = positiveMatches.map((m) => m.candidate);
  const topk = results.slice(0, viewMode === "topk" ? topK : results.length);
  if (!exemplars.length && !topk.length) return;

  setStatus("Exporting GeoParquet\u2026");
  try {
    const db = await getDuckDB();
    const conn = await db.connect();

    const rows: string[] = [];
    for (const ex of exemplars) {
      const c = centroid(ex.bbox);
      rows.push(
        `('exemplar', ${sqlString(ex.chips_id)}, ${c.lat}, ${c.lng}, ${ex.bbox.west}, ${ex.bbox.south}, ${ex.bbox.east}, ${ex.bbox.north}, NULL::DOUBLE, NULL::INT, x'${wkbPointHex(c.lng, c.lat)}'::BLOB)`,
      );
    }
    for (const [i, r] of topk.entries()) {
      const c = centroid(r.bbox);
      rows.push(
        `('candidate', ${sqlString(r.chips_id)}, ${c.lat}, ${c.lng}, ${r.bbox.west}, ${r.bbox.south}, ${r.bbox.east}, ${r.bbox.north}, ${r.score}, ${i + 1}, x'${wkbPointHex(c.lng, c.lat)}'::BLOB)`,
      );
    }

    const vfsPath = "/tmp/export.parquet";
    await conn.query(`
      COPY (
        SELECT * FROM (
          VALUES ${rows.join(",\n")}
        ) AS t(type, chips_id, lat, lng, west, south, east, north, score, rank, geometry)
      ) TO '${vfsPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
    `);

    const raw = await db.copyFileToBuffer(vfsPath);
    await conn.close();

    const buf = makeGeoParquet(raw, GEO_META);

    const blob = new Blob([buf.buffer as ArrayBuffer], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terrabit-export-${Date.now()}.parquet`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      `Exported ${exemplars.length} exemplar(s) + ${topk.length} candidates to GeoParquet.`,
    );
  } catch (err) {
    setStatus(
      `Export failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
