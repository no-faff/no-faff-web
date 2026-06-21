import type { Config, Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// Walks every blob in the installerclean-results store across all
// schema-version prefixes and returns one row per accepted report: the
// receive timestamp recovered from the blob key, bytesFreed converted
// to GB to one decimal, and the missingFromDiskCount as-is. Rows come
// back oldest first. Feeds the build-time chart + README table refresh
// (scripts/refresh-reports.mjs); the full per-field dataset is the
// gated /api/installerclean-export.
//
// The opt-in reports the upstream client sends are counts-only; there
// is no machine identifier, no path, no user name, no IP. Full
// timestamps are fine to surface.

const STORE_NAME = "installerclean-results";
const CACHE_MAX_AGE_SECONDS = 300;

// Key shape produced by netlify/edge-functions/result-log.ts is a
// version prefix (`v1/`, `v2/`, or `v<n>-unknown/` for a version the
// write side does not yet validate) followed by the ISO timestamp
// (with [:.] replaced by -) and an 8-hex suffix. Matching every
// version prefix means a future schema bump's reports are aggregated
// rather than silently dropped, which is the bug this endpoint carried
// when it matched only `v1/`.
const KEY_PATTERN =
  /^v\d+(?:-unknown)?\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]+\.json$/;

type StoredRecord = {
  scan?: { missingFromDiskCount?: number };
  operation?: { bytesFreed?: number };
};

export type Run = { ts: string; gb: number; missing: number };
export type RunsResponse = { generatedAt: string; runs: Run[] };

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain" },
    });
  }

  // Optional incremental fetch: ?since=<ISO timestamp> returns only
  // reports at or after that instant, so a refresh that already holds the
  // back-catalogue reads only what is new. ISO-8601 UTC sorts
  // lexicographically, so the comparison is a plain string compare.
  const since = new URL(req.url).searchParams.get("since") ?? undefined;

  let body: RunsResponse;
  try {
    body = await listRuns(since);
  } catch (err) {
    console.error("installerclean-runs listRuns failed", err);
    return new Response("Aggregation error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // A since-filtered reply is a partial slice for one caller's merge,
      // not the canonical full series, so it must not sit in a shared
      // cache; only the unfiltered reply is cacheable.
      "Cache-Control": since ? "no-store" : `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// Netlify Blobs exposes no batch read, so each body is its own request.
// Reading them one-at-a-time made the walk O(N) sequential round-trips,
// which at ~80 stored reports began brushing the edge function's
// wall-clock limit. A bounded worker pool keeps a fixed number of reads
// in flight: wall-clock O(N / POOL) without opening an unbounded number
// of connections at once.
const FETCH_POOL = 24;

async function fetchBodies<T>(
  keys: string[],
  read: (key: string) => Promise<T | null>,
): Promise<T[]> {
  const out: (T | null)[] = new Array(keys.length).fill(null);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= keys.length) return;
      out[i] = await read(keys[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_POOL, keys.length) }, worker));
  return out.filter((v): v is T => v !== null);
}

export async function listRuns(since?: string): Promise<RunsResponse> {
  const store = getStore(STORE_NAME);

  // store.list is metadata-only and paginated, so enumerating keys stays
  // cheap even at thousands of reports; only the per-key body reads cost.
  // With `since` set, bodies are read for new reports alone: the store is
  // immutable and append-only (result-log.ts only ever writes a fresh
  // key, never rewrites or deletes), so a report already pulled never
  // needs reading again.
  const keys: string[] = [];
  for await (const page of store.list({ paginate: true })) {
    for (const entry of page.blobs) {
      const ts = timestampFromKey(entry.key);
      if (!ts) continue;
      if (since && ts < since) continue;
      keys.push(entry.key);
    }
  }

  const runs = await fetchBodies<Run>(keys, async (key): Promise<Run | null> => {
    const ts = timestampFromKey(key);
    if (!ts) return null;

    let raw: string | null;
    try {
      raw = await store.get(key, { type: "text" });
    } catch {
      return null;
    }
    if (!raw) return null;

    let record: StoredRecord;
    try {
      record = JSON.parse(raw) as StoredRecord;
    } catch {
      return null;
    }

    // No schemaVersion gate. bytesFreed and missingFromDiskCount sit at
    // the same path in every schema shipped (the v2 bump only added
    // obsoletedCount and re-split supersededCount), and both are read
    // defensively. Gating on a known-version set is what made this
    // endpoint silently drop every v1.8.2 report.
    const bytesFreed = nonNegFinite(record.operation?.bytesFreed);
    const missing = nonNegFinite(record.scan?.missingFromDiskCount);
    return { ts, gb: roundToOneDecimal(bytesFreed / 1e9), missing };
  });

  runs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { generatedAt: new Date().toISOString(), runs };
}

export function timestampFromKey(key: string): string | null {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function nonNegFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundToOneDecimal(n: number): number {
  return Math.round(n * 10) / 10;
}

export const config: Config = {
  path: "/api/installerclean-runs",
};
