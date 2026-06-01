import type { Config, Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// Authenticated full export of the InstallerClean opt-in reports.
// Companion to the public /api/installerclean-runs (which returns only
// { ts, gb, missing } per report). This endpoint returns every stored
// field of every report across all schema-version prefixes, for the
// operator's own tooling to pull into a single local file and query.
//
// Why gated, when the stored bodies are PII-free by construction
// (result-log.ts allowlists every key at every object level, so the
// store never holds free-form bytes): a public firehose of "everything
// the app sends home" is precisely the asset a bad-faith reader
// screenshots as proof of phoning-home, even though the data is opt-in
// and anonymous. The gate exists for that, not for secrecy of the
// contents. It is a shared-secret header check, not user
// authentication, and is best-effort.
//
// Fail-closed: when REPORTS_EXPORT_KEY is unset in the environment the
// endpoint refuses every request, so a deploy that forgets to set the
// secret never serves the full dataset unguarded.

const STORE_NAME = "installerclean-results";

// Mirrors the key shape minted by result-log.ts: a version prefix
// (v1/, v2/, or v<n>-unknown/ for a version the write side does not yet
// validate) then the ISO timestamp with [:.] replaced by - and an
// 8-hex suffix. Matching every version prefix means a schema bump's
// reports export rather than being silently dropped, the same contract
// /api/installerclean-runs holds.
const KEY_PATTERN =
  /^v\d+(?:-unknown)?\/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]+\.json$/;

export type ExportEntry = Record<string, unknown> & { ts: string; key: string };
export type ExportResponse = { generatedAt: string; count: number; reports: ExportEntry[] };

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain" },
    });
  }

  // Trim the configured key: a trailing newline or space pasted into
  // the Netlify env panel would otherwise mismatch the clean header
  // the puller sends and 401 every request with no visible cause
  // (the same whitespace footgun that bit NOTIFY_EMAIL).
  const expected = Deno.env.get("REPORTS_EXPORT_KEY")?.trim();
  if (!expected) {
    return new Response("Export not configured", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const provided = (req.headers.get("x-export-key") ?? "").trim();
  if (!keyMatches(provided, expected)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let body: ExportResponse;
  try {
    body = await exportReports();
  } catch (err) {
    console.error("installerclean-export failed", err);
    return new Response("Aggregation error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // Operator tooling pull carrying the full dataset, not a
      // cacheable public surface: it must not sit in any shared cache.
      "Cache-Control": "no-store",
    },
  });
}

export async function exportReports(): Promise<ExportResponse> {
  const store = getStore(STORE_NAME);
  const reports: ExportEntry[] = [];

  for await (const page of store.list({ paginate: true })) {
    for (const entry of page.blobs) {
      const ts = timestampFromKey(entry.key);
      if (!ts) continue;

      let raw: string | null;
      try {
        raw = await store.get(entry.key, { type: "text" });
      } catch {
        continue;
      }
      if (!raw) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }

      // ts and key first, then the literal stored body. The body's own
      // keys (schemaVersion, app, os, scan, operation) are the
      // write-side allowlist, so the spread cannot introduce a ts/key
      // collision with attacker-controlled names.
      reports.push({ ts, key: entry.key, ...record });
    }
  }

  reports.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { generatedAt: new Date().toISOString(), count: reports.length, reports };
}

export function timestampFromKey(key: string): string | null {
  const m = KEY_PATTERN.exec(key);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

// Length-checked equality. Deliberately not constant-time: the threat
// model is an optics gate over PII-free data, not credential
// protection, so a timing side-channel on a random key is not worth
// edge-runtime contortions to close.
export function keyMatches(provided: string, expected: string): boolean {
  return provided.length === expected.length && provided === expected;
}

export const config: Config = {
  path: "/api/installerclean-export",
};
