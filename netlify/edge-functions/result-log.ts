import type { Config, Context } from "@netlify/edge-functions";
import { getStore } from "@netlify/blobs";

// Netlify Edge Function. Receives diagnostic logs POSTed by
// InstallerClean's "Send result" button on the completion screen.
// Stores each accepted body as one blob in the
// "installerclean-results" store, keyed by ISO timestamp + a short
// random suffix so concurrent submissions never collide.
//
// Schema is defined and versioned in the desktop client at
// src/InstallerClean.Core/Models/ResultLogEntry.cs. The function
// validates required field types up front so the Blob store never
// holds a structurally-broken record that a future read endpoint
// could echo back.
//
// SchemaVersion is checked so a future client bumping the shape can
// roll out without breaking older deployed function code: any
// unsupported version is stored under a separate prefix and a 200
// still goes back so a slightly-newer client doesn't see "server
// error" for what is really a deployment lag.

const ALLOWED_VERSIONS = new Set([1]);
const MAX_BODY_BYTES = 64 * 1024;
const STORE_NAME = "installerclean-results";

// The client User-Agent header is captured into Blob metadata. The
// regex matches the client's documented shape so an attacker-controlled
// long or PII-bearing UA cannot land in storage.
const USER_AGENT_PATTERN = /^InstallerClean\/\d+\.\d+\.\d+$/;

const PENDING_REBOOT_LABELS = new Set([
  "clean",
  "msiExecuteMutexHeld",
  "installerInProgress",
  "pendingRenameInCache",
]);
const OPERATION_KINDS = new Set(["scan", "move", "delete"]);
const OPERATION_OUTCOMES = new Set([
  "complete",
  "partial",
  "cancelled",
  "failed",
  "noFiles",
]);
const MOVE_DESTINATION_KINDS = new Set([
  "sameDrive",
  "differentFixedDrive",
  "removableDrive",
  "uncShare",
  "unknown",
]);

export default async function handler(req: Request, _ctx: Context): Promise<Response> {
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

  const schemaVersion = parsed.schemaVersion;
  if (typeof schemaVersion !== "number") {
    return new Response("Missing schemaVersion", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Schema-version 1 is checked field-by-field. Unknown versions skip
  // validation (stored under v<n>-unknown/) so a forward-compatible
  // client deployment doesn't 400 against an older function.
  if (schemaVersion === 1) {
    const error = validateSchema1(parsed);
    if (error) {
      return new Response(error, {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  const rawUserAgent = req.headers.get("User-Agent") ?? "";
  const userAgent = USER_AGENT_PATTERN.test(rawUserAgent) ? rawUserAgent : "invalid";

  const versionPrefix = ALLOWED_VERSIONS.has(schemaVersion) ? "v1" : `v${schemaVersion}-unknown`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomUUID().split("-")[0];
  const key = `${versionPrefix}/${timestamp}-${suffix}.json`;

  // The envelope intentionally carries no country code and no source
  // IP. The user's confirmation modal shows the literal client payload;
  // adding fields here that the user didn't see would break the
  // "what you see is what gets stored" contract. Netlify's
  // platform-level access log still retains IPs for ~24h, which is
  // the upper bound on IP exposure; nothing here extends that.
  const enriched = JSON.stringify(
    {
      receivedAt: new Date().toISOString(),
      userAgent,
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

function validateSchema1(body: Record<string, unknown>): string | null {
  const app = body.app;
  if (!isPlainObject(app)) return "app must be an object";
  if (typeof app.version !== "string" || !/^\d+\.\d+\.\d+$/.test(app.version)) {
    return "app.version must match semver";
  }

  if (typeof body.os !== "string" || body.os.length === 0 || body.os.length > 200) {
    return "os must be a non-empty string under 200 chars";
  }

  const scan = body.scan;
  if (!isPlainObject(scan)) return "scan must be an object";
  for (const key of [
    "durationMs",
    "registeredCount",
    "orphanedCount",
    "supersededCount",
    "missingFromDiskCount",
  ]) {
    const value = (scan as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `scan.${key} must be a non-negative finite number`;
    }
  }
  if (typeof scan.pendingReboot !== "string" || !PENDING_REBOOT_LABELS.has(scan.pendingReboot)) {
    return "scan.pendingReboot must be a known label";
  }

  const op = body.operation;
  if (!isPlainObject(op)) return "operation must be an object";
  if (typeof op.kind !== "string" || !OPERATION_KINDS.has(op.kind)) {
    return "operation.kind must be scan, move, or delete";
  }
  if (typeof op.outcome !== "string" || !OPERATION_OUTCOMES.has(op.outcome)) {
    return "operation.outcome must be a known label";
  }
  for (const key of ["filesProcessed", "filesFailed", "bytesFreed"]) {
    const value = (op as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `operation.${key} must be a non-negative finite number`;
    }
  }
  if (!Array.isArray(op.errors)) return "operation.errors must be an array";
  if (op.errors.length > 100) return "operation.errors length capped at 100";
  for (const entry of op.errors) {
    if (!isPlainObject(entry)) return "operation.errors entries must be objects";
    if (typeof entry.category !== "string" || entry.category.length === 0 || entry.category.length > 64) {
      return "operation.errors[].category must be a non-empty string under 64 chars";
    }
    if (typeof entry.count !== "number" || !Number.isFinite(entry.count) || entry.count < 0) {
      return "operation.errors[].count must be a non-negative finite number";
    }
  }
  const dest = op.moveDestinationKind;
  if (dest !== null && (typeof dest !== "string" || !MOVE_DESTINATION_KINDS.has(dest))) {
    return "operation.moveDestinationKind must be null or a known label";
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const config: Config = {
  path: "/api/result-log",
};
