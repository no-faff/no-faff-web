import type { Config, Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// Netlify Edge Function. Receives diagnostic logs POSTed by
// InstallerClean's "Send result log" button on the completion screen.
// Stores each accepted body as one blob in the
// "installerclean-results" store, keyed by ISO timestamp + a short
// random suffix so concurrent submissions never collide.
//
// Schema is defined and versioned in the desktop client at
// src/InstallerClean.Core/Models/ResultLogEntry.cs. SchemaVersion
// is checked here so a future client bumping the shape can roll out
// without breaking older deployed function code: any unsupported
// version is stored under a separate prefix and a 200 still goes
// back so a slightly-newer client doesn't see "server error" for
// what is really a deployment lag.

const ALLOWED_VERSIONS = new Set([1]);
const MAX_BODY_BYTES = 64 * 1024;
const STORE_NAME = "installerclean-results";

export default async function handler(req: Request, ctx: Context): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST", "Content-Type": "text/plain" },
    });
  }

  const contentType = req.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return new Response("Content-Type must be application/json", {
      status: 415,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new Response("Body too large", {
      status: 413,
      headers: { "Content-Type": "text/plain" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response("Body is not valid JSON", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (!isPlainObject(parsed)) {
    return new Response("Body must be a JSON object", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
  if (typeof schemaVersion !== "number") {
    return new Response("Missing schemaVersion", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const versionPrefix = ALLOWED_VERSIONS.has(schemaVersion) ? "v1" : `v${schemaVersion}-unknown`;
  const userAgent = req.headers.get("User-Agent") ?? "unknown";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomUUID().split("-")[0];
  const key = `${versionPrefix}/${timestamp}-${suffix}.json`;

  const enriched = JSON.stringify(
    {
      receivedAt: new Date().toISOString(),
      userAgent,
      country: ctx.geo?.country?.code ?? null,
      payload: parsed,
    },
    null,
    2,
  );

  try {
    const store = getStore(STORE_NAME);
    await store.set(key, enriched, { metadata: { userAgent, schemaVersion: String(schemaVersion) } });
  } catch (err) {
    console.error("result-log store.set failed", err);
    return new Response("Storage error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const config: Config = {
  path: "/api/result-log",
};
