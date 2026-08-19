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

// Schema 3 adds the optional per-error `codes` HRESULT histogram and the
// IFileOperation-era delete categories (see ALLOWED_ERROR_CATEGORY). Schema 4
// adds the top-level `machine` object and a batch of scan and operation fields,
// and drops `pendingReboot`. A version outside this set is stored under
// v<n>-unknown/ and still 200s, so a client that ships ahead of this deploy
// never loses a report.
//
// THAT LENIENCE STOPS AT THE TOP LEVEL, which is why this function has to be
// deployed before a client that sends schema 4 ships: the top-level allowlist
// runs for every version including the ones this cannot validate, so a `machine`
// key arriving before this deploy is a 400 and a user told sending failed.
//
// AND THE SCHEMA-4 LISTS BELOW MOVED WITHOUT THE VERSION MOVING, which is the
// same rule read the other way: a key that stops being produced is a
// subtraction, and an allowlisting receiver needs no new version to understand
// one. Six keys went, four under scan and two under operation, when the client's
// identity check was removed; twenty-one arrived, twenty under machine and one
// under scan. Only the additions could ever have been rejected, and the
// subtractions were required fields here, so both halves were fatal until this
// deploy. Nothing was renamed on the wire.
//
// NO RELEASE EVER SENT EITHER SHAPE. Schema 4 has shipped in no version, so the
// v4 lists have exactly one client and it is the unreleased one they now match.
const ALLOWED_VERSIONS = new Set([1, 2, 3, 4]);

// The version at which `machine` arrives and `pendingReboot` leaves. Named
// rather than repeated, because the two moves are one schema change and a
// future reader has to see that they cannot come apart.
const FIRST_MACHINE_VERSION = 4;
const MAX_BODY_BYTES = 64 * 1024;
const STORE_NAME = "installerclean-results";

// The client User-Agent header is captured into Blob metadata. The
// regex matches the client's documented shape so an attacker-controlled
// long or PII-bearing UA cannot land in storage.
const USER_AGENT_PATTERN = /^InstallerClean\/\d+\.\d+\.\d+$/;

// Schema 1 to 3 only. The client dropped the field at schema 4: a move or a
// delete is gated on that state before it can run, so it could only ever vary on
// a scan-only run, and across every report received it never did.
const PENDING_REBOOT_LABELS = new Set([
  "clean",
  "msiExecuteMutexHeld",
  "installerInProgress",
  "pendingRenameInCache",
]);

// Where the machine still generates 8dot3 short names. The first four mirror the
// four settings Microsoft's fsutil 8dot3name reference documents for
// NtfsDisable8dot3NameCreation, inverted (the registry value disables); the last
// three are the three ways of having no setting to report, which the client keeps
// apart because one label for all three would be false of two of them.
const SHORT_NAME_CREATION_LABELS = new Set([
  "allVolumes",
  "noVolumes",
  "perVolume",
  "systemVolumeOnly",
  "unset",
  "unrecognised",
  "unreadable",
]);

// The display language, as a BCP 47 tag, plus the word the client sends when the
// UI culture is invariant and has no name. A PATTERN rather than the allowlist
// this file uses everywhere else, and deliberately: the set of shipped languages
// grows between releases, and an allowlist would reject the reports from every
// new one until this function redeployed. The bound is what an allowlist is
// really for here, and 20 characters of [a-z-] cannot carry a payload.
const LANGUAGE_PATTERN = /^(invariant|[a-z]{2,3}(-[A-Za-z]{2,8}){0,2})$/;

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
// the ones validateReport understands); the per-object allowlists
// run inside validateReport because the published schema for an
// unknown version is by definition unknown.
const ALLOWED_TOP = new Set(["schemaVersion", "app", "os", "machine", "scan", "operation"]);

// PER-VERSION AND EXACT, not a union with the odd version-gated extra check. A
// union would accept a schema-3 report carrying schema-4 keys and a schema-4
// report still carrying pendingReboot, and both are a client that has gone wrong
// in a way worth hearing about rather than one to quietly accommodate. Being
// exact also means the unknown-key check does the whole job: there is no separate
// list of keys a version must NOT have, which is the list that goes stale.
const ALLOWED_APP_LEGACY = new Set(["version"]);
const ALLOWED_APP_V4 = new Set(["version", "language"]);

const ALLOWED_SCAN_LEGACY = new Set([
  "durationMs",
  "registeredCount",
  "orphanedCount",
  "supersededCount",
  "obsoletedCount",
  "missingFromDiskCount",
  "pendingReboot",
]);
const ALLOWED_SCAN_V4 = new Set([
  "durationMs",
  "registeredCount",
  "registeredBytes",
  "orphanedCount",
  "supersededCount",
  "obsoletedCount",
  "removableBytes",
  "missingFromDiskCount",
  "missingNeededCount",
  "withheldPatchCount",
  "unreadableProductCount",
  "skippedProductRowCount",
  "unclaimedProductFileCount",
  "unclaimedPatchFileCount",
  "recoveredProductCount",
  "unansweredProductCount",
]);

const ALLOWED_OPERATION_LEGACY = new Set([
  "kind",
  "outcome",
  "filesProcessed",
  "filesFailed",
  "bytesFreed",
  "errors",
  "moveDestinationKind",
]);
const ALLOWED_OPERATION_V4 = new Set([
  "kind",
  "outcome",
  "durationMs",
  "filesProcessed",
  "filesFailed",
  "bytesFreed",
  "errors",
  "moveDestinationKind",
  "heldBackReclaimed",
  "heldBackRecordsChanged",
  "heldBackRecordsUnreadable",
]);

// In the order the client serialises them, which is the order the schema pin in
// InstallerClean.Tests/Models/ResultLogEntryTests.cs enumerates: that pin is the
// authoritative list, CI checks it against the real serialised output, and this
// set was taken from it rather than transcribed from the record declaration.
// Keeping the order means a diff between the two is read down two columns.
//
// THE LAST ONE IS DERIVED ON THE CLIENT, the sum of the four refusal causes
// above it, and it arrives as a key like any other. It is allowlisted and
// required here for that reason and not treated as a total to be recomputed:
// the client computes it at the one place the parts are read so that a total
// contradicting its own breakdown is impossible, and a receiver recomputing it
// would be a second opinion nobody needs.
const ALLOWED_MACHINE = new Set([
  "shortNameCreation",
  "longFileNameCount",
  "nonStringLocalPackageCount",
  "unreadablePatchStateCount",
  "unreadableVerdictPathCount",
  "unparseableProductKeyCount",
  "productCount",
  "registryProductKeyCount",
  "patchClaimCount",
  "instanceProductCount",
  "instanceTypeUnreadableCount",
  "supersededRegistrationCount",
  "obsoletedRegistrationCount",
  "productPatchKeyCount",
  "productPatchRegistrationCount",
  "productsWithRemovablePatchCount",
  "productsWithPatchSetUnestablishedCount",
  "pathResolverAttemptCount",
  "pathResolverNotAPathCount",
  "pathResolverNoAncestorCount",
  "pathResolverOpenRefusedCount",
  "pathResolverNoFinalNameCount",
  "pathResolverFaultedCount",
  "pathNormalisationRefusedAtExpansionCount",
  "pathNormalisationRefusedAtPrefixStripCount",
  "pathNormalisationRefusedAtFullPathCount",
  "pathNormalisationRefusedAtEmbeddedNullCount",
  "pathNormalisationRefusedCount",
  // Derived client-side over the five pathResolver*Count members above it, and it
  // arrives as a key like any other, exactly as pathNormalisationRefusedCount does.
  // ADDED AHEAD OF THE CLIENT ON PURPOSE. The client change that produces it is
  // written and not yet released, and this file's own rule is that the function
  // deploys before a client sending a new key ships: an unknown key is a 400 at
  // this level and the user is told sending failed. Allowing a key nothing sends
  // yet costs nothing, because the per-object lists permit rather than require;
  // allowing it late loses every report from every machine that had the condition,
  // which is the one population these reports exist to hear from.
  "pathResolverRefusedCount",
]);

// `codes` was populated by the two shell-delete categories alone, both retired
// with the Recycle Bin, so no schema-4 client can send it and a schema-4 report
// carrying one is not a report this understands.
const ALLOWED_ERROR_LEGACY = new Set(["category", "count", "codes"]);
const ALLOWED_ERROR_V4 = new Set(["category", "count"]);

// Numeric fields required by version, so a client that stops sending one is a
// 400 rather than a series that quietly goes to zero. The v4 list is every
// numeric key in that version's shape: they are all sent on all three run kinds,
// zero being a real answer rather than an absent field.
const SCAN_NUMERIC_LEGACY = [
  "durationMs",
  "registeredCount",
  "orphanedCount",
  "supersededCount",
  "missingFromDiskCount",
];
const SCAN_NUMERIC_V4 = [
  "durationMs",
  "registeredCount",
  "registeredBytes",
  "orphanedCount",
  "supersededCount",
  "obsoletedCount",
  "removableBytes",
  "missingFromDiskCount",
  "missingNeededCount",
  "withheldPatchCount",
  "unreadableProductCount",
  "skippedProductRowCount",
  "unclaimedProductFileCount",
  "unclaimedPatchFileCount",
  "recoveredProductCount",
  "unansweredProductCount",
];
const OPERATION_NUMERIC_LEGACY = ["filesProcessed", "filesFailed", "bytesFreed"];
const OPERATION_NUMERIC_V4 = [
  "durationMs",
  "filesProcessed",
  "filesFailed",
  "bytesFreed",
  "heldBackReclaimed",
  "heldBackRecordsChanged",
  "heldBackRecordsUnreadable",
];

// Every machine key except shortNameCreation, which is the one label in the
// object and is checked against its own set below.
//
// REQUIRING ALL OF THEM IS SAFE BECAUSE NO SHIPPED CLIENT SENDS THIS OBJECT AT
// ALL. Requiring a key a released version does not send would 400 that version,
// which is the trap this list sits in; it does not spring here, because the
// machine object arrives with schema 4 and no release has ever sent schema 4.
// Every tag from v1.9.0 to v2.3.0 sends 3, v1.8.2 sends 2, v1.8.0 and v1.8.1
// send 1, so every client in the field goes down the LEGACY path and never
// reaches this list. Anything added here later has to be asked the same
// question, because by then a schema-4 client will have shipped.
const MACHINE_NUMERIC = [
  "longFileNameCount",
  "nonStringLocalPackageCount",
  "unreadablePatchStateCount",
  "unreadableVerdictPathCount",
  "unparseableProductKeyCount",
  "productCount",
  "registryProductKeyCount",
  "patchClaimCount",
  "instanceProductCount",
  "instanceTypeUnreadableCount",
  "supersededRegistrationCount",
  "obsoletedRegistrationCount",
  "productPatchKeyCount",
  "productPatchRegistrationCount",
  "productsWithRemovablePatchCount",
  "productsWithPatchSetUnestablishedCount",
  "pathResolverAttemptCount",
  "pathResolverNotAPathCount",
  "pathResolverNoAncestorCount",
  "pathResolverOpenRefusedCount",
  "pathResolverNoFinalNameCount",
  "pathResolverFaultedCount",
  "pathNormalisationRefusedAtExpansionCount",
  "pathNormalisationRefusedAtPrefixStripCount",
  "pathNormalisationRefusedAtFullPathCount",
  "pathNormalisationRefusedAtEmbeddedNullCount",
  "pathNormalisationRefusedCount",
];

// Optional per-error HRESULT histogram, schema 3 only and delete only. Keys are
// the shell HRESULT formatted exactly as the client renders it for
// display: 0x followed by eight uppercase hex digits. Values are per-code
// file counts. One error bucket can hold files that failed with different
// codes, so it is a map, not a single code. Bounded like the errors array.
const HRESULT_KEY_PATTERN = /^0x[0-9A-F]{8}$/;
const MAX_ERROR_CODES = 100;

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
// subclasses in InstallerClean.Core.Models. Anything else rejects the whole
// report with a 400, and the user is told sending failed, so a category
// missing from this set is silent data loss that cannot be measured after
// the fact: the reports that would have counted it are the ones discarded.
// CandidateOutsideCache and FileInUse were shipped by the client in v2.1.0
// and were absent here until 2026-08-01, so every run that failed because
// another program held a file open was rejected for two releases.
//
// Three entries are legacy-only and no current client can send them.
// ShellRefused is the SHFileOperation-era recycle failure emitted up to
// v1.8.2; RecycleFailed and PermanentlyDeleted are its IFileOperation-era
// successors from v1.8.3, retired with the Recycle Bin itself. All three stay
// accepted because older clients are still installed, and they are accepted at
// every version rather than only the legacy ones: what a category means does not
// change with the envelope around it, and a client is free to keep an installed
// copy of an old release while a newer one reports beside it.
const ALLOWED_ERROR_CATEGORY = new Set([
  "MissingSourceFile",
  "AccessDenied",
  "DestinationCollision",
  "SourceIsReparsePoint",
  "CandidateOutsideCache",
  "FileInUse",
  "IOFailure",
  "UnknownError",
  "ShellRefused",
  "RecycleFailed",
  "PermanentlyDeleted",
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
  //
  // AND THAT IS WHY A NEW TOP-LEVEL KEY MEANS THIS FUNCTION DEPLOYS BEFORE THE
  // CLIENT SHIPS. Everything below the top level is forgiving of a version this
  // does not know; this line is not, so `machine` arriving early would be a 400
  // and a user told sending failed, which is the one failure mode the lenient
  // v<n>-unknown/ path exists to avoid.
  const topUnknown = topLevelUnknownKey(parsed);
  if (topUnknown) {
    return new Response(`unknown key at top level: ${truncate(topUnknown)}`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Known schema versions are checked field-by-field. Unknown versions
  // skip the field-level validation (stored under v<n>-unknown/) so a
  // forward-compatible client deployment doesn't 400 against an older
  // function.
  if (ALLOWED_VERSIONS.has(schemaVersion)) {
    const error = validateReport(parsed, schemaVersion);
    if (error) {
      return new Response(error, {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      });
    }
  }

  const rawUserAgent = req.headers.get("User-Agent") ?? "";
  const userAgent = USER_AGENT_PATTERN.test(rawUserAgent) ? rawUserAgent : "invalid";

  const versionPrefix = ALLOWED_VERSIONS.has(schemaVersion) ? `v${schemaVersion}` : `v${schemaVersion}-unknown`;
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

/**
 * The first top-level key this does not recognise, or null. Exported so a test
 * can put a real client payload through the SAME gate the handler runs: this one
 * applies at every schemaVersion, including the ones validateReport cannot check,
 * so it is the gate a forward-deployed client trips and the only one whose
 * failure reaches a user as "Sending failed".
 */
export function topLevelUnknownKey(body: Record<string, unknown>): string | null {
  return unknownKey(body, ALLOWED_TOP);
}

export function validateReport(body: Record<string, unknown>, version: number): string | null {
  // Top-level allowlist runs above this function so unknown
  // schemaVersions are also filtered. Per-object allowlists below are
  // chosen by version: v1 to v3 share one shape (the only difference
  // between them being scan.obsoletedCount, which schema 2 adds and
  // schema 1 omits) and v4 is its own.
  const isV4 = version >= FIRST_MACHINE_VERSION;

  const app = body.app;
  if (!isPlainObject(app)) return "app must be an object";
  const appUnknown = unknownKey(app, isV4 ? ALLOWED_APP_V4 : ALLOWED_APP_LEGACY);
  if (appUnknown) return `unknown key in app: ${truncate(appUnknown)}`;
  if (typeof app.version !== "string" || !/^\d+\.\d+\.\d+$/.test(app.version)) {
    return "app.version must match semver";
  }
  if (isV4 && (typeof app.language !== "string" || !LANGUAGE_PATTERN.test(app.language))) {
    return "app.language must be a language tag";
  }

  if (typeof body.os !== "string" || !ALLOWED_OS.has(body.os)) {
    return "os must be a known family / architecture label";
  }

  // The machine object arrives with schema 4 and must be absent before it: the
  // top-level allowlist has to accept the key for every version so that a
  // forward-deployed client is not rejected, so this is where a v3 report
  // carrying one is caught.
  const machine = body.machine;
  if (isV4) {
    if (!isPlainObject(machine)) return "machine must be an object";
    const machineUnknown = unknownKey(machine, ALLOWED_MACHINE);
    if (machineUnknown) return `unknown key in machine: ${truncate(machineUnknown)}`;
    if (
      typeof machine.shortNameCreation !== "string" ||
      !SHORT_NAME_CREATION_LABELS.has(machine.shortNameCreation)
    ) {
      return "machine.shortNameCreation must be a known label";
    }
    const machineError = requireNonNegativeNumbers(machine, MACHINE_NUMERIC, "machine");
    if (machineError) return machineError;
  } else if (machine !== undefined) {
    return "machine is not part of this schema version";
  }

  const scan = body.scan;
  if (!isPlainObject(scan)) return "scan must be an object";
  const scanUnknown = unknownKey(scan, isV4 ? ALLOWED_SCAN_V4 : ALLOWED_SCAN_LEGACY);
  if (scanUnknown) return `unknown key in scan: ${truncate(scanUnknown)}`;
  const scanNumericKeys = isV4 ? [...SCAN_NUMERIC_V4] : [...SCAN_NUMERIC_LEGACY];
  // Schema 2 adds obsoletedCount (PatchState=4 split out of
  // supersededCount). Required from v2 on, absent in v1; v4's own list
  // already carries it.
  if (!isV4 && version >= 2) scanNumericKeys.push("obsoletedCount");
  const scanError = requireNonNegativeNumbers(scan, scanNumericKeys, "scan");
  if (scanError) return scanError;
  if (!isV4 && (typeof scan.pendingReboot !== "string" || !PENDING_REBOOT_LABELS.has(scan.pendingReboot))) {
    return "scan.pendingReboot must be a known label";
  }

  const op = body.operation;
  if (!isPlainObject(op)) return "operation must be an object";
  const opUnknown = unknownKey(op, isV4 ? ALLOWED_OPERATION_V4 : ALLOWED_OPERATION_LEGACY);
  if (opUnknown) return `unknown key in operation: ${truncate(opUnknown)}`;
  if (typeof op.kind !== "string" || !OPERATION_KINDS.has(op.kind)) {
    return "operation.kind must be scan, move, or delete";
  }
  if (typeof op.outcome !== "string" || !OPERATION_OUTCOMES.has(op.outcome)) {
    return "operation.outcome must be a known label";
  }
  const opError = requireNonNegativeNumbers(
    op, isV4 ? OPERATION_NUMERIC_V4 : OPERATION_NUMERIC_LEGACY, "operation");
  if (opError) return opError;
  if (!Array.isArray(op.errors)) return "operation.errors must be an array";
  if (op.errors.length > 100) return "operation.errors length capped at 100";
  for (const entry of op.errors) {
    if (!isPlainObject(entry)) return "operation.errors entries must be objects";
    const errUnknown = unknownKey(entry, isV4 ? ALLOWED_ERROR_V4 : ALLOWED_ERROR_LEGACY);
    if (errUnknown) return `unknown key in operation.errors[]: ${truncate(errUnknown)}`;
    if (typeof entry.category !== "string" || !ALLOWED_ERROR_CATEGORY.has(entry.category)) {
      return "operation.errors[].category must be a known FileOperationError subtype";
    }
    if (typeof entry.count !== "number" || !Number.isFinite(entry.count) || entry.count < 0) {
      return "operation.errors[].count must be a non-negative finite number";
    }
    // codes is optional (only recycle-failure categories carry it) and is
    // shape-validated when present: a plain object of bounded size, hex
    // HRESULT keys, non-negative finite counts. No free-form bytes reach
    // the store, matching the allowlist discipline of every other field.
    const codes = entry.codes;
    if (codes !== undefined) {
      if (!isPlainObject(codes)) {
        return "operation.errors[].codes must be an object";
      }
      const codeKeys = Object.keys(codes);
      if (codeKeys.length > MAX_ERROR_CODES) {
        return `operation.errors[].codes capped at ${MAX_ERROR_CODES} entries`;
      }
      for (const codeKey of codeKeys) {
        if (!HRESULT_KEY_PATTERN.test(codeKey)) {
          return `operation.errors[].codes key must be a 0xNNNNNNNN HRESULT: ${truncate(codeKey)}`;
        }
        const codeCount = codes[codeKey];
        if (typeof codeCount !== "number" || !Number.isFinite(codeCount) || codeCount < 0) {
          return "operation.errors[].codes values must be non-negative finite numbers";
        }
      }
    }
  }
  const dest = op.moveDestinationKind;
  if (dest !== null && (typeof dest !== "string" || !MOVE_DESTINATION_KINDS.has(dest))) {
    return "operation.moveDestinationKind must be null or a known label";
  }

  return null;
}

// Every count in this schema is a non-negative finite number, so the three
// objects check theirs the same way rather than each spelling out the same loop.
// A missing key fails on the type check, which is the point: an absent count and
// a count of zero are different reports, and only one of them is a client that
// has stopped sending something.
function requireNonNegativeNumbers(
  obj: Record<string, unknown>,
  keys: readonly string[],
  objectName: string,
): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return `${objectName}.${key} must be a non-negative finite number`;
    }
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
      // Length is logged (not the address) so a recipient mismatch
      // between the Resend account and the configured NOTIFY_EMAIL
      // is diagnosable from the function log without leaking the
      // address into the log stream.
      console.error(
        "result-log notify email rejected",
        resp.status,
        "to-length",
        notifyEmail.length,
        body.slice(0, 500),
      );
    }
  } catch (err) {
    console.error("result-log notify email threw", err);
  }
}

export const config: Config = {
  path: "/api/result-log",
};
