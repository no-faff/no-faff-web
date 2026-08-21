import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { validateReport, topLevelUnknownKey } from '../../netlify/edge-functions/result-log';

// END-TO-END, not a re-statement of the schema in a second place.
//
// The fixtures under tests/fixtures/installerclean are the literal bytes the
// desktop client serialises: produced by running InstallerClean.Core's own
// ResultLogEntry types through the same JsonSerializerOptions ResultLogService
// posts with, one per run kind. Nothing here re-types a field name, so a field
// renamed on the client is a failure HERE rather than a key silently dropped in
// the store and a series that quietly goes flat.
//
// Regenerating them: construct the entry from InstallerClean.Core's own record
// types and serialise it with WriteIndented and CamelCase, which is what
// ResultLogService posts with, then drop the output in beside the others. A
// fixture must never be hand-edited to make a test pass; that is the one edit
// that would turn this file back into a re-statement of the schema.
//
// THE v3 PAIR IS GENERATED FROM THE v2.3.0 TAG, not from the current client, and
// they are the reason this file can answer the question a v4-only suite cannot:
// whether the newest release anybody has installed still validates. Every
// released version sends schema 3 or lower, so those two are the shape actually
// in the field and the v4 three are the shape nothing has shipped yet.
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'installerclean');

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const v4Names = names.filter((n) => n.startsWith('v4-'));
const legacyNames = names.filter((n) => !n.startsWith('v4-'));

describe('real client payloads', () => {
  it('there are fixtures to check, one per run kind and one per era', () => {
    // Without this the it.each blocks below pass vacuously over an empty
    // directory, which reads exactly like a clean run.
    expect(names).toEqual([
      'v3-delete-with-errors.json',
      'v3-scan-only.json',
      'v4-delete-with-errors.json',
      'v4-move.json',
      'v4-scan-only.json',
    ]);
    expect(v4Names).toHaveLength(3);
    expect(legacyNames).toHaveLength(2);
  });

  it.each(names)('%s passes the top-level allowlist', (name) => {
    // The gate that runs for EVERY schemaVersion, so it is the one a client
    // shipping ahead of this deploy trips, and the only rejection a user sees.
    expect(topLevelUnknownKey(load(name))).toBeNull();
  });

  it.each(names)('%s passes full field validation', (name) => {
    const report = load(name);
    expect(validateReport(report, report.schemaVersion)).toBeNull();
  });

  // Patterns for the things that must never reach the store. Every one is a
  // NEGATIVE assertion, and a negative with a typo in it passes against
  // everything, so the row below runs them against text that must match before
  // any fixture is asked. A control that cannot fail is not a control.
  const forbidden: Array<[string, RegExp]> = [
    ['a drive letter', /[A-Za-z]:\\\\/],
    ['a path separator', /\\\\/],
    ['a product or patch code', /\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-/],
    ['a profile segment', /users/i],
    ['a cached file name', /\.msi|\.msp/i],
  ];

  it.each(forbidden)('the %s pattern matches text that contains one', (_label, pattern) => {
    const bad = JSON.stringify({
      path: 'C:\\Users\\someone\\AppData\\Local\\a.msi',
      code: '{01234567-89AB-CDEF-0123-456789ABCDEF}',
      patch: 'x.msp',
    });

    expect(bad).toMatch(pattern);
  });

  it.each(names)('%s carries no path, no name and no identifier', (name) => {
    // The schema's whole promise, checked against the bytes rather than against
    // the record's doc comment. A drive letter, a separator, a user profile
    // segment, a product code or a cached file name reaching the store would be
    // the failure that matters most here, and it would not look like a failure
    // anywhere else: the report would be accepted and stored exactly as sent.
    const raw = readFileSync(join(FIXTURES, name), 'utf8');

    for (const [, pattern] of forbidden) expect(raw).not.toMatch(pattern);
  });

  it('the scan-only payload reports zero for every operation figure', () => {
    // Zero rather than an absent key, which is what lets the receiver require
    // the same fields on all three run kinds.
    const op = load('v4-scan-only.json').operation;

    expect(op.kind).toBe('scan');
    for (const key of [
      'durationMs', 'filesProcessed', 'filesFailed', 'bytesFreed',
      'heldBackReclaimed', 'heldBackRecordsChanged', 'heldBackRecordsUnreadable',
    ]) {
      expect(op[key]).toBe(0);
    }
  });

  it('every error category the client can emit is accepted', () => {
    // THE ONE FAULT IN THIS AREA WITH A HISTORY, and the reason it is checked
    // against the categories rather than a couple of samples: a category the
    // receiver does not allowlist rejects the WHOLE report, so the runs that
    // would have counted it are exactly the runs discarded. A rename on the
    // client once reached the point of shipping while this end still knew only
    // the old names, which would have binned every delete-failure report until
    // somebody noticed, and a reporting path going quiet reads identically to
    // nothing being wrong.
    //
    // The fixture's categories are produced by reflecting over the client's own
    // FileOperationError subtypes, which is the same derivation the client uses
    // to name them, so a new or renamed subtype arrives here rather than being
    // remembered here.
    const errors = load('v4-delete-with-errors.json').operation.errors;
    const categories = errors.map((e: any) => e.category);

    expect(categories.length).toBeGreaterThan(1);
    expect(new Set(categories).size).toBe(categories.length);
    for (const category of categories) {
      const r = load('v4-move.json');
      r.operation.errors = [{ category, count: 1 }];
      r.operation.filesFailed = 1;
      r.operation.outcome = 'partial';
      expect([category, validateReport(r, 4)]).toEqual([category, null]);
    }

    // The control. Without it the loop above passes just as well against a
    // receiver that accepts any string at all.
    const r = load('v4-move.json');
    r.operation.errors = [{ category: 'VrunklyPhandiferFailure', count: 1 }];
    r.operation.filesFailed = 1;
    expect(validateReport(r, 4)).toMatch(/category/i);
  });

  it('a held-back file is reported under its own cause', () => {
    const op = load('v4-delete-with-errors.json').operation;

    expect(op.heldBackReclaimed).toBe(1);
    expect(op.heldBackRecordsChanged).toBe(0);
    expect(op.heldBackRecordsUnreadable).toBe(0);
  });

  it('the degraded payload carries every census term non-zero', () => {
    // WITHOUT THIS THE FIXTURE SUITE PASSES OVER A ROW OF ZEROES, which would
    // satisfy any validator at all and prove nothing about these fields. One
    // fixture is a machine that answered less cleanly, and every term it can
    // report is distinct so a transposition between two of them fails here rather
    // than cancelling out.
    //
    // IT IS WRITTEN AS "EVERY KEY" RATHER THAN A LIST OF THE INTERESTING ONES,
    // because a list is what went stale: the fixture and this file both described
    // a machine object of eight keys long after the client had twenty-eight, and
    // a named-key assertion passes happily while the twenty it does not name are
    // missing entirely.
    const r = load('v4-delete-with-errors.json');
    const numeric = Object.entries(r.machine).filter(([k]) => k !== 'shortNameCreation');

    expect(r.machine.shortNameCreation).toBe('systemVolumeOnly');
    expect(numeric).toHaveLength(43);
    for (const [key, value] of numeric) expect([key, value]).not.toEqual([key, 0]);
    expect(new Set(numeric.map(([, v]) => v)).size).toBe(numeric.length);

    // Every scan term this fixture can carry, and obsoletedCount is deliberately
    // not among them: it is derived from the offer, and an obsoleted patch cannot
    // reach the offer, so a non-zero here would be a state the client cannot
    // produce. The machine object's obsoletedRegistrationCount is where that
    // class shows up, and it is non-zero above.
    for (const key of [
      'missingFromDiskCount', 'missingNeededCount', 'withheldPatchCount',
      'unreadableProductCount', 'skippedProductRowCount', 'unclaimedProductFileCount',
      'unclaimedPatchFileCount', 'recoveredProductCount', 'unansweredProductCount',
    ]) {
      expect([key, r.scan[key]]).not.toEqual([key, 0]);
    }
  });

  it('the refusal total agrees with its own four parts, on the wire', () => {
    // The client derives it rather than taking it as a parameter, so a total
    // contradicting its breakdown inside one object is meant to be impossible.
    // Checked against the bytes anyway: "impossible" is a property of the code
    // that built the object, and this is the object that arrives.
    for (const name of v4Names) {
      const m = load(name).machine;
      expect(m.pathNormalisationRefusedCount).toBe(
        m.pathNormalisationRefusedAtExpansionCount +
        m.pathNormalisationRefusedAtPrefixStripCount +
        m.pathNormalisationRefusedAtFullPathCount +
        m.pathNormalisationRefusedAtEmbeddedNullCount,
      );
    }
  });

  it('the two product-shortfall findings are kept apart', () => {
    // One counts products Windows was asked about and would not answer for; the
    // other counts registry key names that yielded no product code, so Windows
    // was never asked. A sentence about what Windows would not say is false of
    // every member of the second, which is why one figure carrying both was
    // split. They sit in different objects because they answer different
    // questions: two scans of one machine agree about the second and need not
    // agree about the first.
    for (const name of v4Names) {
      const r = load(name);
      expect(r.scan).toHaveProperty('unansweredProductCount');
      expect(r.machine).toHaveProperty('unparseableProductKeyCount');
      expect(r.scan).not.toHaveProperty('unparseableProductKeyCount');
      expect(r.machine).not.toHaveProperty('unansweredProductCount');
      // The key that carried both. Its removal is why the receiver stopped
      // requiring it, and a client sending it again is a client that has gone
      // backwards rather than one to accommodate.
      expect(r.scan).not.toHaveProperty('unresolvableProductCount');
    }
  });

  it('no released client sends the schema the v4 lists validate', () => {
    // THE QUESTION THIS FILE EXISTS TO ANSWER, and the one a v4-only suite
    // cannot: the receiver's v4 lists were brought into line with an unreleased
    // client, and every version anybody has installed sends schema 3 or lower.
    // Those go down the legacy path, which this change did not touch.
    for (const name of legacyNames) {
      const r = load(name);
      expect(r.schemaVersion).toBeLessThan(4);
      expect(r).not.toHaveProperty('machine');
      expect(r.scan).toHaveProperty('pendingReboot');
      expect(validateReport(r, r.schemaVersion)).toBeNull();
    }
  });

  it('the pairing count and the path count both travel, in the same object', () => {
    // They are one measurement at two granularities and the pair is the reading:
    // failures concentrated on one shared patch and failures spread across many
    // are different faults wearing one number, and only the two side by side tell
    // them apart. Splitting them across objects would throw that away.
    const r = load('v4-delete-with-errors.json');

    expect(r.machine).toHaveProperty('unreadablePatchStateCount');
    expect(r.machine).toHaveProperty('unreadableVerdictPathCount');
    expect(r.scan).not.toHaveProperty('unreadableVerdictPathCount');
  });

  it('no payload carries a total over the held-back causes', () => {
    // Three causes and no sum, so nothing downstream can be tempted into one
    // sentence over a set that has several. It was five until the identity check
    // came out, and the count in this comment is the sort that goes stale
    // silently, so the assertion is written against the absence rather than
    // against the number.
    for (const name of names) {
      expect(JSON.stringify(load(name))).not.toContain('heldBackTotal');
    }
  });
});
