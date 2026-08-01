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
