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

import { listRuns, timestampFromKey } from '../../netlify/edge-functions/installerclean-runs';

function key(ts: string, suffix = 'a1b2c3d4', prefix = 'v1'): string {
  return `${prefix}/${ts.replace(/[:.]/g, '-')}-${suffix}.json`;
}

function record(bytesFreed: number, missing = 0, schemaVersion = 1): string {
  return JSON.stringify({
    schemaVersion,
    app: { version: '1.8.1' },
    scan: { missingFromDiskCount: missing },
    operation: { kind: 'delete', outcome: 'complete', bytesFreed },
  });
}

describe('timestampFromKey', () => {
  it('recovers an ISO timestamp from the receive-side key shape', () => {
    expect(timestampFromKey('v1/2026-05-13T14-23-45-678Z-a3f9c2b1.json')).toBe(
      '2026-05-13T14:23:45.678Z',
    );
  });

  it('recovers timestamps from any version prefix', () => {
    expect(timestampFromKey('v2/2026-05-13T14-23-45-678Z-a3f9c2b1.json')).toBe(
      '2026-05-13T14:23:45.678Z',
    );
    expect(timestampFromKey('v2-unknown/2026-05-13T14-23-45-678Z-a3f9c2b1.json')).toBe(
      '2026-05-13T14:23:45.678Z',
    );
  });

  it('returns null for keys that do not match the timestamp shape', () => {
    expect(timestampFromKey('v1/not-a-timestamp.json')).toBeNull();
    expect(timestampFromKey('notaversion/2026-05-13T14-23-45-678Z-a3f9c2b1.json')).toBeNull();
  });
});

describe('listRuns', () => {
  beforeEach(() => {
    blobState.blobs.clear();
  });

  it('returns no runs when the store is empty', async () => {
    const out = await listRuns();
    expect(out.runs).toEqual([]);
  });

  it('returns one entry per accepted v1 record with gb to one decimal', async () => {
    blobState.blobs.set(key('2026-05-13T14:23:45.678Z'), record(25_000_000_000));
    blobState.blobs.set(key('2026-05-13T15:00:00.000Z', 'b2c3d4e5'), record(0));
    blobState.blobs.set(
      key('2026-05-13T16:00:00.000Z', 'c3d4e5f6'),
      record(9_140_000_000, 1),
    );

    const out = await listRuns();
    expect(out.runs).toEqual([
      { ts: '2026-05-13T14:23:45.678Z', gb: 25.0, missing: 0 },
      { ts: '2026-05-13T15:00:00.000Z', gb: 0, missing: 0 },
      { ts: '2026-05-13T16:00:00.000Z', gb: 9.1, missing: 1 },
    ]);
  });

  it('orders runs by timestamp ascending regardless of list order', async () => {
    blobState.blobs.set(key('2026-05-15T10:00:00.000Z', 'cccccccc'), record(1_000_000_000));
    blobState.blobs.set(key('2026-05-13T10:00:00.000Z', 'aaaaaaaa'), record(2_000_000_000));
    blobState.blobs.set(key('2026-05-14T10:00:00.000Z', 'bbbbbbbb'), record(3_000_000_000));

    const out = await listRuns();
    expect(out.runs.map((r) => r.ts)).toEqual([
      '2026-05-13T10:00:00.000Z',
      '2026-05-14T10:00:00.000Z',
      '2026-05-15T10:00:00.000Z',
    ]);
  });

  it('includes records from every schema-version prefix', async () => {
    // v1 report under v1/, v2 report under v2-unknown/ (where the write
    // side files a version it does not yet validate). Both must be
    // aggregated; gating on v1 only is what dropped every v1.8.2 report.
    blobState.blobs.set(key('2026-05-13T14:23:45.678Z'), record(1_000_000_000));
    blobState.blobs.set(
      key('2026-05-13T15:00:00.000Z', 'b2c3d4e5', 'v2-unknown'),
      record(2_000_000_000, 0, 2),
    );

    const out = await listRuns();
    expect(out.runs).toEqual([
      { ts: '2026-05-13T14:23:45.678Z', gb: 1.0, missing: 0 },
      { ts: '2026-05-13T15:00:00.000Z', gb: 2.0, missing: 0 },
    ]);
  });

  it('treats missing or non-finite bytesFreed and missing counts as zero', async () => {
    blobState.blobs.set(
      key('2026-05-13T14:23:45.678Z'),
      JSON.stringify({ schemaVersion: 1, scan: {}, operation: {} }),
    );
    const out = await listRuns();
    expect(out.runs).toEqual([{ ts: '2026-05-13T14:23:45.678Z', gb: 0, missing: 0 }]);
  });

  it('skips blobs whose key does not match the timestamp shape', async () => {
    blobState.blobs.set('v1/not-a-timestamp.json', record(5_000_000_000));
    blobState.blobs.set(key('2026-05-13T14:23:45.678Z'), record(1_000_000_000));
    const out = await listRuns();
    expect(out.runs).toEqual([{ ts: '2026-05-13T14:23:45.678Z', gb: 1.0, missing: 0 }]);
  });
});
