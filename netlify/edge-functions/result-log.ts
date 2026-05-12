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
// validates required field types and rejects unknown keys at every
// object level, so the Blob store never holds attacker-controlled
// bytes that a future read endpoint could echo back.
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

// Allowlists for known keys at each object level. Envelopes containing
// any other key are rejected so an attacker cannot pad
// `body.app.extraJunk = "x".repeat(60_000)` into a stored blob. The
// top-level allowlist is enforced for every schemaVersion (not only
// the ones validateSchema1 understands); the per-object allowlists
// run inside validateSchema1 because the published schema for an
// unknown version is by definition unknown.
const ALLOWED_TOP = new Set(["schemaVersion", "app", "os", "scan", "operation"]);
const ALLOWED_APP = new Set(["version"]);
const ALLOWED_SCAN = new Set([
  "durationMs",
  "registeredCount",
  "orphanedCount",
  "supersededCount",
  "missingFromDiskCount",
  "pendingReboot",
]);
const ALLOWED_OPERATION = new Set([
  "kind",
  "outcome",
  "filesProcessed",
  "filesFailed",
  "bytesFreed",
  "errors",
  "moveDestinationKind",
]);
const ALLOWED_ERROR = new Set(["category", "count"]);

// Architecture suffix from RuntimeInformation.OSArchitecture mirrors
// .NET's Architecture enum names; the four family labels come from
// ResultLogEntry.ResolveOs. The combinations are the only legitimate
// client outputs.
const ALLOWED_OS = new Set([
  "Windows 11 (X64)",
  "Windows 11 (X86)",
  "Windows 11 (Arm64)",
  "Windows 11 (Arm)",
  "Windows 10 (X64)",
  "Windows 10 (X86)",
  "Windows 10 (Arm64)",
  "Windows 10 (Arm)",
  "Windows (X64)",
  "Windows (X86)",
  "Windows (Arm64)",
  "Windows (Arm)",
  "Unknown (X64)",
  "Unknown (X86)",
  "Unknown (Arm64)",
  "Unknown (Arm)",
]);

// Categories are the C# runtime type names of FileOperationError's
// subclasses in InstallerClean.Core.Models. Anything else rejects.
const ALLOWED_ERROR_CATEGORY = new Set([
  "MissingSourceFile",
  "AccessDenied",
  "DestinationCollision",
  "ShellRefused",
  "SourceIsReparsePoint",
  "IOFailure",
  "UnknownError",
]);

// Reflected key names in 400 responses are truncated to this width so
// a 60 KiB key in a request cannot mint a 60 KiB response body.
const MAX_KEY_ECHO = 40;

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

  // Reject oversize at the Content-Length header before decoding so a
  // hostile client can't tie up the function on a 6 MiB body. The
  // header can be spoofed; the post-decode byte check below is the
  // belt to this braces.
  const claimedLength = parseInt(req.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(claimedLength) && claimedLength > MAX_BODY_BYTES) {
    return new Response("Body too large", {
      status: 413,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const raw = await req.text();
  // raw.length is the UTF-16 code-unit count of the decoded string.
  // A request of 65,535 Chinese characters (3 bytes each in UTF-8)
  // passes a `raw.length <= MAX_BODY_BYTES` check at ~196 KiB on the
  // wire. Measure the encoded byte length so the cap means what it
  // says.
  const bodyBytes = new TextEncoder().encode(raw).length;
  if (bodyBytes > MAX_BODY_BYTES) {
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

  // Top-level unknown-key allowlist runs for EVERY schemaVersion, not
  // only v1. A POST with schemaVersion: 2 and `body.padding = "x"
  // .repeat(60000)` would otherwise reach store.set unfiltered through
  // the forward-compat branch below. Any future schema that bumps
  // the version also gets added to ALLOWED_TOP if it introduces new
  // top-level keys.
  const topUnknown = unknownKey(parsed, ALLOWED_TOP);
  if (topUnknown) {
    return new Response(`unknown key at top level: ${truncate(topUnknown)}`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Schema-version 1 is checked field-by-field. Unknown versions skip
  // the field-level validation (stored under v<n>-unknown/) so a
  // forward-compatible client deployment doesn't 400 against an older
  // function.
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

  // The stored blob body is the literal client payload, nothing
  // added. The user's confirmation modal showed exactly this; the
  // "what you see is what gets stored" contract is a literal property
  // of the blob. Netlify retains a per-blob uploadedAt at the
  // platform layer (visible via store.list()) so receive-time
  // ordering is preserved without a separate timestamp here. The
  // validated User-Agent lives only in Blob metadata, which the
  // public stats endpoint never surfaces.
  const stored = JSON.stringify(parsed, null, 2);

  try {
    const store = getStore(STORE_NAME);
    await store.set(key, stored, { metadata: { userAgent, schemaVersion: String(schemaVersion) } });
  } catch (err) {
    console.error("result-log store.set failed", err);
    return new Response("Storage error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Operator notification. The blob is already durable as of the
  // store.set above, so an email failure does NOT change the
  // response code: the client's contract is "did the server
  // preserve my report", which is yes regardless. RESEND_API_KEY
  // and NOTIFY_EMAIL are read at call time so the email can be
  // turned on or off purely via the Netlify env panel without a
  // redeploy.
  await sendNotificationEmail(parsed, stored);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validateSchema1(body: Record<string, unknown>): string | null {
  // Top-level allowlist runs above this function so unknown
  // schemaVersions are also filtered. Per-object allowlists below
  // are gated on knowing the v1 shape.

  const app = body.app;
  if (!isPlainObject(app)) return "app must be an object";
  const appUnknown = unknownKey(app, ALLOWED_APP);
  if (appUnknown) return `unknown key in app: ${truncate(appUnknown)}`;
  if (typeof app.version !== "string" || !/^\d+\.\d+\.\d+$/.test(app.version)) {
    return "app.version must match semver";
  }

  if (typeof body.os !== "string" || !ALLOWED_OS.has(body.os)) {
    return "os must be a known family / architecture label";
  }

  const scan = body.scan;
  if (!isPlainObject(scan)) return "scan must be an object";
  const scanUnknown = unknownKey(scan, ALLOWED_SCAN);
  if (scanUnknown) return `unknown key in scan: ${truncate(scanUnknown)}`;
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
  const opUnknown = unknownKey(op, ALLOWED_OPERATION);
  if (opUnknown) return `unknown key in operation: ${truncate(opUnknown)}`;
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
    const errUnknown = unknownKey(entry, ALLOWED_ERROR);
    if (errUnknown) return `unknown key in operation.errors[]: ${truncate(errUnknown)}`;
    if (typeof entry.category !== "string" || !ALLOWED_ERROR_CATEGORY.has(entry.category)) {
      return "operation.errors[].category must be a known FileOperationError subtype";
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

function unknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return key;
  }
  return null;
}

function truncate(value: string): string {
  return value.length > MAX_KEY_ECHO ? value.slice(0, MAX_KEY_ECHO) + "..." : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// POSTs the just-stored payload to Resend so the operator gets one
// email per accepted report. No-op if either env var is unset, so a
// deployment with Resend not yet configured continues to write
// blobs as before. Errors are logged to the function console and
// swallowed: the report is already durable in Blobs storage and the
// desktop client's success path must not depend on a third-party
// mail provider's availability.
//
// Sender is the shared Resend onboarding address, which works with
// an unverified domain. Switching to a custom From requires a
// domain verified in Resend's dashboard.
async function sendNotificationEmail(
  payload: Record<string, unknown>,
  stored: string,
): Promise<void> {
  const notifyEmail = Deno.env.get("NOTIFY_EMAIL");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  if (!notifyEmail || !resendApiKey) return;

  const op = (payload as { operation?: { kind?: string; outcome?: string } }).operation ?? {};
  const app = (payload as { app?: { version?: string } }).app ?? {};
  const outcome = op.outcome ?? "unknown";
  const prefix = outcome === "failed" ? "[FAILED] " : "";
  const subject = `${prefix}InstallerClean ${op.kind ?? "?"} ${outcome} (v${app.version ?? "?"})`;

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "InstallerClean <onboarding@resend.dev>",
        to: notifyEmail,
        subject,
        text: stored,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error("result-log notify email rejected", resp.status, body.slice(0, 500));
    }
  } catch (err) {
    console.error("result-log notify email threw", err);
  }
}

export const config: Config = {
  path: "/api/result-log",
};
