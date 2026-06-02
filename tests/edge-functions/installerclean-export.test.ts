import { describe, it, expect, beforeEach, vi } from 'vitest';

const blobState = vi.hoisted(() => ({ blobs: new Map<string, string>() }));

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    list: async function* () {
      yield { blobs: [...blobState.blobs.keys()].map((key) => ({ key })) };
    },
    get: async (key: string) => blobState.blobs.get(key) ?? null,
  }),
}));

import {
  exportReports,
  timestampFromKey,
  keyMatches,
} from '../../netlify/edge-functions/installerclean-export';

function key(ts: string, suffix = 'a1b2c3d4', prefix = 'v2'): string {
  return `${prefix}/${ts.replace(/[:.]/g, '-')}-${suffix}.json`;
}

function record(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    app: { version: '1.8.2' },
    os: 'Windows 11 (X64)',
    scan: { missingFromDiskCount: 0, pendingReboot: 'clean' },
    operation: {
      kind: 'delete',
      outcome: 'failed',
      bytesFreed: 0,
      errors: [{ category: 'ShellRefused', count: 2 }],
    },
    ...extra,
  });
}

describe('keyMatches', () => {
  it('accepts an exact match', () => {
    expect(keyMatches('abc123', 'abc123')).toBe(true);
  });

  it('rejects a mismatch, empty, or wrong-length key', () => {
    expect(keyMatches('abc', 'abc123')).toBe(false);
    expect(keyMatches('', 'abc123')).toBe(false);
    expect(keyMatches('abc124', 'abc123')).toBe(false);
  });

  it('treats a trailing newline as a mismatch (handler trims before comparing)', () => {
    // keyMatches itself is exact; the handler is what trims. This
    // documents that an untrimmed pair would NOT match, which is why
    // the handler trims both sides.
    expect(keyMatches('abc123\n', 'abc123')).toBe(false);
  });
});

describe('timestampFromKey', () => {
  it('recovers timestamps from any version prefix', () => {
    expect(timestampFromKey('v2-unknown/2026-05-28T00-31-35-277Z-9a5e37a1.json')).toBe(
      '2026-05-28T00:31:35.277Z',
    );
    expect(timestampFromKey('v2/2026-05-28T10-45-26-039Z-b7703544.json')).toBe(
      '2026-05-28T10:45:26.039Z',
    );
  });

  it('returns null for keys that do not match the timestamp shape', () => {
    expect(timestampFromKey('v2/nope.json')).toBeNull();
    expect(timestampFromKey('notaversion/2026-05-28T00-31-35-277Z-9a5e37a1.json')).toBeNull();
  });
});

describe('exportReports', () => {
  beforeEach(() => {
    blobState.blobs.clear();
  });

  it('returns no reports when the store is empty', async () => {
    const out = await exportReports();
    expect(out.reports).toEqual([]);
    expect(out.count).toBe(0);
  });

  it('returns the full body of each report with ts + key, across all prefixes, oldest first', async () => {
    blobState.blobs.set(key('2026-05-28T10:45:26.039Z', 'b7703544', 'v2'), record());
    blobState.blobs.set(key('2026-05-28T00:31:35.277Z', '9a5e37a1', 'v2-unknown'), record());
    blobState.blobs.set(key('2026-05-13T10:00:00.000Z', 'cccccccc', 'v1'), record({ schemaVersion: 1 }));

    const out = await exportReports();
    expect(out.count).toBe(3);
    expect(out.reports.map((r) => r.ts)).toEqual([
      '2026-05-13T10:00:00.000Z',
      '2026-05-28T00:31:35.277Z',
      '2026-05-28T10:45:26.039Z',
    ]);

    // Full body preserved, including the error categories the aggregate
    // endpoints never expose.
    const failed = out.reports.find((r) => r.ts === '2026-05-28T10:45:26.039Z') as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    expect(failed.operation.errors).toEqual([{ category: 'ShellRefused', count: 2 }]);
    expect(failed.os).toBe('Windows 11 (X64)');
    expect(failed.key).toContain('v2/');
  });

  it('preserves the schema-3 per-error codes map through export', async () => {
    // The export spreads the literal stored body, so the codes
    // histogram lands losslessly in reports.json for analysis; this
    // pins that contract against a future "tidy the payload" change.
    blobState.blobs.set(
      key('2026-06-02T10:00:00.000Z', 'eeeeeeee', 'v3'),
      record({
        schemaVersion: 3,
        operation: {
          kind: 'delete',
          outcome: 'failed',
          bytesFreed: 0,
          errors: [{ category: 'RecycleFailed', count: 2, codes: { '0x80004005': 2 } }],
        },
      }),
    );

    const out = await exportReports();
    const r = out.reports[0] as Record<string, any>;
    expect(r.operation.errors[0].codes).toEqual({ '0x80004005': 2 });
  });

  it('skips blobs with unparseable JSON or a non-conforming key', async () => {
    blobState.blobs.set(key('2026-05-28T10:45:26.039Z'), record());
    blobState.blobs.set(key('2026-05-28T11:00:00.000Z', 'dddddddd'), '{ not json');
    blobState.blobs.set('v2/not-a-timestamp.json', record());

    const out = await exportReports();
    expect(out.count).toBe(1);
  });
});
