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
//   - totalRuns / totalBytesFreed / runs by outcome / runs by
//     operation kind / runs by pending-reboot reason: pure counts
//     with no user identifier, no per-machine trace, no temporal
//     fingerprint.
//
//   - runsFreedNothing / runsFreedSomething / bytesFreedWhenNonZero
//     (count, mean, max, min): the nothing-vs-something run split
//     and a summary of operation.bytesFreed over the runs that freed
//     something. Counts and the mean are aggregates; max and min are
//     each one run's exact bytesFreed, but that figure is not an
//     identifier and is surfaced with no country, OS or timestamp
//     beside it, so an extreme value cannot pick out a machine.
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

// The stored blob is the literal client payload. The pre-r2
// `{ receivedAt, userAgent, country, payload }` envelope is gone;
// receive-time ordering is preserved at the platform layer via
// per-blob uploadedAt and is not surfaced here. The aggregator only
// reads schema-1 fields by name; unknown keys are filtered at write
// time by the result-log endpoint.
type StoredRecord = {
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

// Summary of operation.bytesFreed across the runs that freed > 0
// bytes. count mirrors runsFreedSomething; it is repeated inside this
// object so the block reads as a self-contained statistic. An empty
// freed-something group yields zeroes (see summariseFreed).
type BytesFreedStats = {
  count: number;
  mean: number;
  max: number;
  min: number;
};

type FreedBreakdown = {
  runsFreedNothing: number;
  runsFreedSomething: number;
  bytesFreedWhenNonZero: BytesFreedStats;
};

type Stats = {
  generatedAt: string;
  totalRuns: number;
  totalBytesFreed: number;
  runsFreedNothing: number;
  runsFreedSomething: number;
  bytesFreedWhenNonZero: BytesFreedStats;
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

export async function aggregate(): Promise<Stats> {
  const store = getStore(STORE_NAME);

  let totalRuns = 0;
  let totalBytesFreed = 0;
  const bytesFreedPerRun: number[] = [];
  const runsByOutcome: Record<string, number> = {};
  const runsByOperation: Record<string, number> = {};
  const pendingRebootDistribution: Record<string, number> = {};
  const moveDestinationKindDistribution: Record<string, number> = {};
  const appVersionCounts: Record<string, number> = {};

  // Iterate every blob across all version prefixes (v1/, v2/, and the
  // v<n>-unknown/ fallback the write side mints for a version newer
  // than its allowlist). The fields read below (operation.kind /
  // outcome / bytesFreed / moveDestinationKind, scan.pendingReboot,
  // app.version) are identical across schema 1 and 2; schema 2's only
  // structural change was splitting obsoletedCount out of
  // supersededCount, neither of which this aggregator reads. A
  // previous prefix: "v1/" + `schemaVersion !== 1` filter silently
  // excluded the entire v1.8.0+ (schema-2) population, so totalRuns
  // and every distribution under-counted; anything keying a display
  // off this endpoint would have shown numbers matching nothing else.
  // If a future schema bump changes one of the read fields, branch on
  // schemaVersion for that field rather than reintroducing a prefix
  // filter that drops whole populations.
  for await (const page of store.list({ paginate: true })) {
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

      // A finite version >= 1 marks a real stored report; reject a
      // stray non-report blob without pinning to a single version.
      if (typeof record.schemaVersion !== "number" || record.schemaVersion < 1) continue;

      totalRuns++;

      const op = record.operation ?? {};
      const bytesFreed =
        typeof op.bytesFreed === "number" && Number.isFinite(op.bytesFreed) ? op.bytesFreed : 0;
      totalBytesFreed += bytesFreed;
      bytesFreedPerRun.push(bytesFreed);
      bump(runsByOutcome, op.outcome);
      bump(runsByOperation, op.kind);
      bump(moveDestinationKindDistribution, op.moveDestinationKind);

      const scan = record.scan ?? {};
      bump(pendingRebootDistribution, scan.pendingReboot);

      const appVersion = record.app?.version;
      if (typeof appVersion === "string" && /^\d+\.\d+\.\d+$/.test(appVersion)) {
        appVersionCounts[appVersion] = (appVersionCounts[appVersion] ?? 0) + 1;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    totalRuns,
    totalBytesFreed,
    ...summariseFreed(bytesFreedPerRun),
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

// Splits one bytesFreed value per run into freed-nothing (=== 0) and
// freed-something (> 0) buckets, and summarises the freed-something
// bucket. Single pass, so no Math.max(...hugeArray) call-stack risk.
// An empty freed-something bucket returns zeroes: mean is guarded
// against 0/0, and max / min never leak their Infinity seeds.
export function summariseFreed(bytesFreedPerRun: number[]): FreedBreakdown {
  let runsFreedSomething = 0;
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const bytes of bytesFreedPerRun) {
    if (bytes <= 0) continue;
    runsFreedSomething++;
    sum += bytes;
    if (bytes > max) max = bytes;
    if (bytes < min) min = bytes;
  }
  return {
    runsFreedNothing: bytesFreedPerRun.length - runsFreedSomething,
    runsFreedSomething,
    bytesFreedWhenNonZero: {
      count: runsFreedSomething,
      mean: runsFreedSomething === 0 ? 0 : sum / runsFreedSomething,
      max,
      min: runsFreedSomething === 0 ? 0 : min,
    },
  };
}

export const config: Config = {
  path: "/api/installerclean-stats",
};
