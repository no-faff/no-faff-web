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
// Regenerating them: serialise ResultLogEntry.ForScanOnly / ForMove / ForDelete
// with WriteIndented and CamelCase and drop the output in beside the others. A
// fixture must never be hand-edited to make a test pass; that is the one edit
// that would turn this file back into a re-statement of the schema.
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'installerclean');

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();

describe('real client payloads', () => {
  it('there are fixtures to check, one per run kind', () => {
    // Without this the two it.each blocks below pass vacuously over an empty
    // directory, which reads exactly like a clean run.
    expect(names).toEqual([
      'v4-delete-with-errors.json',
      'v4-move.json',
      'v4-scan-only.json',
    ]);
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
      'heldBackIdentityClaimed', 'heldBackIdentityUnreadable',
    ]) {
      expect(op[key]).toBe(0);
    }
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
    const r = load('v4-delete-with-errors.json');

    expect(r.machine.shortNameCreation).toBe('systemVolumeOnly');
    expect(r.machine.longFileNameCount).toBe(6);
    expect(r.machine.nonStringLocalPackageCount).toBe(1);
    expect(r.machine.unreadablePatchStateCount).toBe(5);
    expect(r.machine.unreadableVerdictPathCount).toBe(4);
    expect(r.machine.unparseableProductKeyCount).toBe(1);
    expect(r.machine.registryProductKeyCount).toBe(140);
    expect(r.scan.unreadableProductCount).toBe(2);
    expect(r.scan.skippedProductRowCount).toBe(1);
    expect(r.scan.unclaimedProductFileCount).toBe(3);
    expect(r.scan.unclaimedPatchFileCount).toBe(1);
    expect(r.scan.recoveredProductCount).toBe(2);
    expect(r.scan.unansweredProductCount).toBe(1);
  });

  it('the two ways a product went unsettled travel as two numbers, never as one', () => {
    // A product code Windows would not answer about, and a registry key name that
    // yielded no code to ask with, are different findings: Windows was never
    // asked about the second, so a sentence about what it would not say is false
    // of every one of them. The app adds them for its own withholding total,
    // where the superordinate "could not be settled" is true of both. Nothing
    // narrower may, and the payload carries no field that does.
    for (const name of names) {
      const r = load(name);
      expect(r.scan).toHaveProperty('unansweredProductCount');
      expect(r.machine).toHaveProperty('unparseableProductKeyCount');
      expect(JSON.stringify(r)).not.toContain('unresolvable');
      expect(JSON.stringify(r)).not.toContain('unsettled');
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
    // Five causes and no sum, so nothing downstream can be tempted into one
    // sentence over a set that has several.
    for (const name of names) {
      expect(JSON.stringify(load(name))).not.toContain('heldBackTotal');
    }
  });
});
