import type { Config, Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// Public aggregator over the InstallerClean diagnostic logs stored
// by the result-log Edge Function. Returns coarse counts and
// distributions only, in shapes that are safe to surface without a
// per-record privacy review on every aggregate.
//
// Privacy floor (each surfaced field reasoned through, not just
// "looks fine"):
//
//   - totalRuns / totalBytesCleared / runs by outcome / runs by
//     operation kind / runs by pending-reboot reason: pure counts
//     with no user identifier, no per-machine trace, no temporal
//     fingerprint.
//
//   - App version distribution: bucketed and capped to top-N so a
//     single rare version (e.g. someone's local dev build) doesn't
//     get echoed back as a 1-of-N statistic that pinpoints them.
//
//   - Move-destination kind distribution: categorical labels only
//     (sameDrive / differentFixedDrive / removableDrive / uncShare /
//     unknown). Never a path.
//
//   - generatedAt: a server timestamp on the *response* so consumers
//     can cache; the underlying records carry receivedAt internally
//     but those are not surfaced individually.
//
// Deliberately NOT surfaced:
//
//   - Country distribution. The result-log function captures
//     ctx.geo.country.code. A country bucket of 1 tells the world
//     someone in (e.g.) Liechtenstein ran a clean. Aggregate
//     country counts without a minimum-bucket-size policy can
//     deanonymise. Decision: omit until a min-bucket-size and a
//     publishable aggregation cadence are agreed.
//
//   - OS string distribution at fine grain. The full
//     RuntimeInformation.OSDescription string can include a
//     Windows build number that narrows a user (e.g. an Insider
//     ring of <100 testers). Decision: omit at fine grain. If
//     surfaced later, bucket to OS family only ("Windows 10",
//     "Windows 11").
//
//   - Time-of-day or per-IP frequency. Source IP is never stored;
//     receivedAt is present on each blob but not surfaced as a
//     time-series here.
//
//   - Individual-run access. The per-record blob list is never
//     returned through this endpoint; reading individual records
//     requires Netlify CLI / dashboard access.
//
// Caching: the response is Cache-Control: public, max-age=300 so
// each Edge invocation does not re-list every blob. 5 minutes is
// more than enough for a usage-stats display on a public page,
// and bounds Netlify Blob list-reads to ~12/hour worst case.

const STORE_NAME = "installerclean-results";
const APP_VERSION_TOP_N = 10;
const CACHE_MAX_AGE_SECONDS = 300;

type StoredRecord = {
  receivedAt?: string;
  userAgent?: string | null;
  country?: string | null;
  payload?: {
    schemaVersion?: number;
    app?: { version?: string };
    scan?: { pendingReboot?: string };
    operation?: {
      kind?: string;
      outcome?: string;
      bytesFreed?: number;
      moveDestinationKind?: string | null;
    };
  };
};

type Stats = {
  generatedAt: string;
  totalRuns: number;
  totalBytesFreed: number;
  runsByOutcome: Record<string, number>;
  runsByOperation: Record<string, number>;
  pendingRebootDistribution: Record<string, number>;
  moveDestinationKindDistribution: Record<string, number>;
  appVersionDistribution: Record<string, number>;
};

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain" },
    });
  }

  let stats: Stats;
  try {
    stats = await aggregate();
  } catch (err) {
    console.error("installerclean-stats aggregation failed", err);
    return new Response("Aggregation error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(JSON.stringify(stats, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function aggregate(): Promise<Stats> {
  const store = getStore(STORE_NAME);

  let totalRuns = 0;
  let totalBytesFreed = 0;
  const runsByOutcome: Record<string, number> = {};
  const runsByOperation: Record<string, number> = {};
  const pendingRebootDistribution: Record<string, number> = {};
  const moveDestinationKindDistribution: Record<string, number> = {};
  const appVersionCounts: Record<string, number> = {};

  // store.list({ paginate: true }) returns an async iterator over
  // pages; iterate every blob under v1/. Schema 2 / 3 / etc keys
  // live under v<n>/ prefixes and are not included here so a future
  // schema bump lands without retrofitting this aggregator first.
  // When v2 ships, add a parallel branch with its own field-mapping
  // rather than reading both shapes at once.
  for await (const page of store.list({ prefix: "v1/", paginate: true })) {
    for (const entry of page.blobs) {
      let raw: string | null;
      try {
        raw = await store.get(entry.key, { type: "text" });
      } catch {
        continue;
      }
      if (!raw) continue;

      let record: StoredRecord;
      try {
        record = JSON.parse(raw) as StoredRecord;
      } catch {
        continue;
      }

      const payload = record.payload;
      if (!payload || payload.schemaVersion !== 1) continue;

      totalRuns++;

      const op = payload.operation ?? {};
      if (typeof op.bytesFreed === "number" && Number.isFinite(op.bytesFreed)) {
        totalBytesFreed += op.bytesFreed;
      }
      bump(runsByOutcome, op.outcome);
      bump(runsByOperation, op.kind);
      bump(moveDestinationKindDistribution, op.moveDestinationKind);

      const scan = payload.scan ?? {};
      bump(pendingRebootDistribution, scan.pendingReboot);

      const appVersion = payload.app?.version;
      if (typeof appVersion === "string" && /^\d+\.\d+\.\d+$/.test(appVersion)) {
        appVersionCounts[appVersion] = (appVersionCounts[appVersion] ?? 0) + 1;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalRuns,
    totalBytesFreed,
    runsByOutcome,
    runsByOperation,
    pendingRebootDistribution,
    moveDestinationKindDistribution,
    appVersionDistribution: topN(appVersionCounts, APP_VERSION_TOP_N),
  };
}

function bump(target: Record<string, number>, key: string | null | undefined): void {
  if (typeof key !== "string" || key.length === 0) return;
  target[key] = (target[key] ?? 0) + 1;
}

function topN(counts: Record<string, number>, n: number): Record<string, number> {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, n));
}

export const config: Config = {
  path: "/api/installerclean-stats",
};
