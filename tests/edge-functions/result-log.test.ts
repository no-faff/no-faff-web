import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { validateReport } from '../../netlify/edge-functions/result-log';

// validateReport runs the per-object allowlists and field checks for a
// known schema version (the handler runs the top-level allowlist and the
// version routing around it). Schema 3 widened it to accept the
// IFileOperation-era delete categories (RecycleFailed / PermanentlyDeleted)
// and an optional per-HRESULT `codes` histogram on each error bucket,
// while still accepting the historical ShellRefused category that v1.8.2
// clients in the field still emit.

// A fresh, fully-valid schema-3 delete report. Tests mutate a clone.
function baseReport(): Record<string, any> {
  return {
    schemaVersion: 3,
    app: { version: '1.8.3' },
    os: 'Windows 11 (X64)',
    scan: {
      durationMs: 100,
      registeredCount: 50,
      orphanedCount: 2,
      supersededCount: 0,
      obsoletedCount: 0,
      missingFromDiskCount: 0,
      pendingReboot: 'clean',
    },
    operation: {
      kind: 'delete',
      outcome: 'failed',
      filesProcessed: 0,
      filesFailed: 3,
      bytesFreed: 0,
      errors: [{ category: 'RecycleFailed', count: 3, codes: { '0x80004005': 2, '0x80070005': 1 } }],
      moveDestinationKind: null,
    },
  };
}

describe('validateReport: schema 3 delete categories and codes', () => {
  it('accepts a v3 RecycleFailed bucket carrying a per-code histogram', () => {
    expect(validateReport(baseReport(), 3)).toBeNull();
  });

  it('accepts a v3 PermanentlyDeleted bucket with codes', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'PermanentlyDeleted', count: 1, codes: { '0x00270008': 1 } }];
    r.operation.filesFailed = 1;
    expect(validateReport(r, 3)).toBeNull();
  });

  // Both categories shipped in the v2.1.0 client and were missing from the
  // allowlist until 2026-08-01, so every run that failed on a locked file
  // was rejected with a 400 for two releases. Pinned here per category
  // rather than as one loop, so a future removal names which one it broke.
  it('accepts a FileInUse bucket, the category a locked file produces', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'FileInUse', count: 3 }];
    expect(validateReport(r, 3)).toBeNull();
  });

  it('accepts a CandidateOutsideCache bucket', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'CandidateOutsideCache', count: 3 }];
    expect(validateReport(r, 3)).toBeNull();
  });

  it('accepts an error bucket with no codes field (codes is optional)', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'MissingSourceFile', count: 2 }];
    r.operation.filesFailed = 2;
    expect(validateReport(r, 3)).toBeNull();
  });

  it('accepts a mixed batch of a coded and an uncoded bucket', () => {
    const r = baseReport();
    r.operation.errors = [
      { category: 'RecycleFailed', count: 1, codes: { '0x80004005': 1 } },
      { category: 'MissingSourceFile', count: 1 },
    ];
    r.operation.filesFailed = 2;
    expect(validateReport(r, 3)).toBeNull();
  });
});

describe('validateReport: historical categories still accepted', () => {
  it('accepts a v2 ShellRefused report (v1.8.2 clients still emit it)', () => {
    const r = baseReport();
    r.schemaVersion = 2;
    r.app.version = '1.8.2';
    r.operation.errors = [{ category: 'ShellRefused', count: 2 }];
    r.operation.filesFailed = 2;
    expect(validateReport(r, 2)).toBeNull();
  });

  it('accepts a v1 ShellRefused report with no obsoletedCount', () => {
    const r = baseReport();
    r.schemaVersion = 1;
    r.app.version = '1.7.0';
    delete r.scan.obsoletedCount;
    r.operation.errors = [{ category: 'ShellRefused', count: 1 }];
    r.operation.filesFailed = 1;
    expect(validateReport(r, 1)).toBeNull();
  });
});

describe('validateReport: codes validation rejects malformed maps', () => {
  it('rejects codes that is not an object', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: 5 }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });

  it('rejects a codes key that is not a 0xNNNNNNNN HRESULT', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: { oops: 1 } }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });

  it('rejects a codes key of the wrong hex width', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: { '0x123': 1 } }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });

  it('rejects a negative codes count', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: { '0x80004005': -1 } }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });

  it('rejects a non-numeric codes count', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: { '0x80004005': 'x' } }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });

  it('rejects a codes map with too many entries', () => {
    const r = baseReport();
    const codes: Record<string, number> = {};
    for (let i = 0; i < 101; i++) codes['0x' + i.toString(16).toUpperCase().padStart(8, '0')] = 1;
    r.operation.errors = [{ category: 'RecycleFailed', count: 101, codes }];
    expect(validateReport(r, 3)).toMatch(/codes/i);
  });
});

describe('validateReport: existing guards still hold', () => {
  it('rejects an unknown error category', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'NotARealCategory', count: 1 }];
    expect(validateReport(r, 3)).not.toBeNull();
  });

  it('rejects an unknown key in an error entry', () => {
    const r = baseReport();
    r.operation.errors = [{ category: 'RecycleFailed', count: 1, codes: { '0x80004005': 1 }, junk: 'x' }];
    expect(validateReport(r, 3)).toMatch(/unknown key/i);
  });

  it('requires obsoletedCount from schema 2 on', () => {
    const r = baseReport();
    delete r.scan.obsoletedCount;
    expect(validateReport(r, 3)).toMatch(/obsoletedCount/);
  });
});

// A fresh, fully-valid schema-4 move report. Schema 4 adds the top-level
// `machine` object and a batch of scan and operation fields, and drops
// `pendingReboot`. Tests mutate a clone.
//
// TAKEN FROM THE CLIENT FIXTURE RATHER THAN WRITTEN OUT HERE, and that is the
// whole point of the change that brought it: the hand-written version of this
// object sat at eight machine keys while the client sent twenty-eight, and it
// went on passing every test in this file, because a hand-written base and a
// hand-written expectation agree with each other whatever the client does. The
// fixture is generated from InstallerClean.Core's own records, so the two can no
// longer drift apart in private.
function v4Report(): Record<string, any> {
  return structuredClone(clientPayload('v4-move.json'));
}

function clientPayload(name: string): Record<string, any> {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'fixtures', 'installerclean', name), 'utf8'),
  );
}

describe('validateReport: schema 4', () => {
  it('accepts a full v4 report', () => {
    expect(validateReport(v4Report(), 4)).toBeNull();
  });

  // EVERY FIELD, ONE AT A TIME. The failure this guards against is a client that
  // stops sending one: the receiver would accept the report, the key would be
  // absent, and the series for that field would go quiet with nothing saying so.
  //
  // DERIVED FROM THE PAYLOAD, so it is every number the client actually sends
  // rather than the subset somebody remembered to list. A key the client adds
  // and the receiver does not allowlist fails the row below; a key the receiver
  // allowlists but does not require fails it too.
  const base = v4Report();
  const requiredNumbers: Array<[string, string]> = ['machine', 'scan', 'operation'].flatMap(
    (object) => Object.entries(base[object])
      .filter(([, value]) => typeof value === 'number')
      .map(([key]) => [object, key] as [string, string]),
  );

  it('the derived list covers every object and is not a short read', () => {
    // Without this the two it.each blocks below scale silently with whatever the
    // fixture happens to hold, and an empty or truncated fixture would read as a
    // clean pass over nothing.
    expect(requiredNumbers.filter(([o]) => o === 'machine')).toHaveLength(27);
    expect(requiredNumbers.filter(([o]) => o === 'scan')).toHaveLength(16);
    expect(requiredNumbers.filter(([o]) => o === 'operation')).toHaveLength(7);
    // The one machine key that is a label rather than a count, so it is checked
    // against its own set instead and must not have been swept in here.
    expect(requiredNumbers).not.toContainEqual(['machine', 'shortNameCreation']);
  });

  it.each(requiredNumbers)('requires %s.%s', (object, key) => {
    const r = v4Report();
    delete r[object][key];
    expect(validateReport(r, 4)).toMatch(new RegExp(`${object}\\.${key}`));
  });

  it.each(requiredNumbers)('rejects a negative %s.%s', (object, key) => {
    const r = v4Report();
    r[object][key] = -1;
    expect(validateReport(r, 4)).toMatch(new RegExp(`${object}\\.${key}`));
  });

  it('requires the machine object', () => {
    const r = v4Report();
    delete r.machine;
    expect(validateReport(r, 4)).toMatch(/machine/);
  });

  it.each([
    'allVolumes',
    'noVolumes',
    'perVolume',
    'systemVolumeOnly',
    'unset',
    'unrecognised',
    'unreadable',
  ])('accepts the short-name label %s', (label) => {
    const r = v4Report();
    r.machine.shortNameCreation = label;
    expect(validateReport(r, 4)).toBeNull();
  });

  it('rejects an unknown short-name label', () => {
    const r = v4Report();
    r.machine.shortNameCreation = 'sometimes';
    expect(validateReport(r, 4)).toMatch(/shortNameCreation/);
  });

  it.each(['en-GB', 'pt-BR', 'zh-Hans', 'ja', 'uk', 'invariant'])(
    'accepts the language tag %s', (tag) => {
      const r = v4Report();
      r.app.language = tag;
      expect(validateReport(r, 4)).toBeNull();
    });

  it.each(['', 'not a tag', 'x'.repeat(200), 'EN-GB'])(
    'rejects the language value %#', (tag) => {
      const r = v4Report();
      r.app.language = tag;
      expect(validateReport(r, 4)).toMatch(/language/);
    });

  it('rejects a v4 report still carrying pendingReboot', () => {
    // The field left with schema 4. A client still sending it is one that has
    // gone wrong rather than one to quietly accommodate, and the exact per-version
    // key sets are what catch it.
    const r = v4Report();
    r.scan.pendingReboot = 'clean';
    expect(validateReport(r, 4)).toMatch(/unknown key in scan/i);
  });

  it('rejects a v4 error bucket carrying a codes histogram', () => {
    // codes was populated by the two shell-delete categories alone and both went
    // with the Recycle Bin, so no v4 client can produce one.
    const r = v4Report();
    r.operation.errors = [{ category: 'IOFailure', count: 1, codes: { '0x80004005': 1 } }];
    r.operation.filesFailed = 1;
    expect(validateReport(r, 4)).toMatch(/unknown key/i);
  });

  it('accepts a v4 scan-only report, where every operation number is zero', () => {
    // The client's own scan-only payload rather than one assembled here, so this
    // is the run kind as it arrives and not as this file imagines it.
    const r = clientPayload('v4-scan-only.json');

    expect(r.operation.kind).toBe('scan');
    expect(validateReport(r, 4)).toBeNull();
  });

  it('accepts a v4 report carrying every held-back cause at once', () => {
    // A batch can meet several causes, which is why they are separate numbers
    // rather than one. Distinct values so a transposition fails rather than
    // cancelling.
    const r = v4Report();
    r.operation.heldBackReclaimed = 1;
    r.operation.heldBackRecordsChanged = 2;
    r.operation.heldBackRecordsUnreadable = 3;
    expect(validateReport(r, 4)).toBeNull();
  });

  it('rejects a v4 report carrying a key the identity check used to send', () => {
    // Six keys stopped being produced when that check was removed, four under
    // scan and two under operation, and the receiver required all six until this
    // change. They are gone rather than kept optional: no release ever sent
    // schema 4, so nothing in the field can be carrying them, and the per-version
    // key sets are exact by design.
    for (const [object, key] of [
      ['scan', 'unresolvableProductCount'],
      ['scan', 'keptIdentityClaimedCount'],
      ['scan', 'keptIdentityUnreadableCount'],
      ['scan', 'keptIdentityUnaskableCount'],
      ['operation', 'heldBackIdentityClaimed'],
      ['operation', 'heldBackIdentityUnreadable'],
    ] as Array<[string, string]>) {
      const r = v4Report();
      r[object][key] = 0;
      expect(validateReport(r, 4)).toMatch(new RegExp(`unknown key in ${object}`, 'i'));
    }
  });
});

describe('validateReport: the schemas do not leak into each other', () => {
  // The store holds every report ever received and the public chart reads all of
  // them, so a change made for schema 4 that quietly invalidated schema 3 would
  // not show up as an error anywhere: it would show up as older reports failing
  // to validate on a re-check nobody runs.
  it('still accepts a full schema 3 report unchanged', () => {
    expect(validateReport(baseReport(), 3)).toBeNull();
  });

  it('still accepts a schema 2 report', () => {
    const r = baseReport();
    r.schemaVersion = 2;
    r.operation.errors = [{ category: 'ShellRefused', count: 3 }];
    expect(validateReport(r, 2)).toBeNull();
  });

  it('still accepts a schema 1 report with no obsoletedCount', () => {
    const r = baseReport();
    r.schemaVersion = 1;
    delete r.scan.obsoletedCount;
    r.operation.errors = [{ category: 'ShellRefused', count: 3 }];
    expect(validateReport(r, 1)).toBeNull();
  });

  it('rejects a schema 3 report carrying the machine object', () => {
    const r = baseReport();
    r.machine = { shortNameCreation: 'unset' };
    expect(validateReport(r, 3)).toMatch(/machine/);
  });

  it.each([
    'registeredBytes',
    'removableBytes',
    'missingNeededCount',
    'withheldPatchCount',
    'unreadableProductCount',
    'unclaimedProductFileCount',
    'recoveredProductCount',
    'unansweredProductCount',
  ])('rejects a schema 3 report carrying the v4 scan key %s', (key) => {
    const r = baseReport();
    r.scan[key] = 1;
    expect(validateReport(r, 3)).toMatch(/unknown key in scan/i);
  });

  it('rejects a schema 3 report carrying a v4 operation key', () => {
    const r = baseReport();
    r.operation.heldBackReclaimed = 0;
    expect(validateReport(r, 3)).toMatch(/unknown key in operation/i);
  });

  it('rejects a schema 3 report carrying app.language', () => {
    const r = baseReport();
    r.app.language = 'en-GB';
    expect(validateReport(r, 3)).toMatch(/unknown key in app/i);
  });

  it('still requires pendingReboot on schema 3', () => {
    const r = baseReport();
    delete r.scan.pendingReboot;
    expect(validateReport(r, 3)).toMatch(/pendingReboot/);
  });
});
