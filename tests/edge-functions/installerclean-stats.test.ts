import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake blob store. blobState is hoisted so the vi.mock factory (which
// runs before the imports below) can close over it; each test fills
// blobState.blobs with key -> JSON-string records.
const blobState = vi.hoisted(() => ({ blobs: new Map<string, string>() }));

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    list: async function* () {
      yield { blobs: [...blobState.blobs.keys()].map((key) => ({ key })) };
    },
    get: async (key: string) => blobState.blobs.get(key) ?? null,
  }),
}));

import { summariseFreed, aggregate } from '../../netlify/edge-functions/installerclean-stats';

describe('summariseFreed', () => {
  it('returns zeroed stats when there are no runs', () => {
    expect(summariseFreed([])).toEqual({
      runsFreedNothing: 0,
      runsFreedSomething: 0,
      bytesFreedWhenNonZero: { count: 0, mean: 0, max: 0, min: 0 },
    });
  });

  it('treats every zero-byte run as a run that freed nothing', () => {
    const result = summariseFreed([0, 0, 0]);
    expect(result.runsFreedNothing).toBe(3);
    expect(result.runsFreedSomething).toBe(0);
    expect(result.bytesFreedWhenNonZero).toEqual({ count: 0, mean: 0, max: 0, min: 0 });
  });

  it('partitions runs into freed-nothing and freed-something, summing to the run count', () => {
    const runs = [0, 1024, 0, 2048];
    const result = summariseFreed(runs);
    expect(result.runsFreedNothing).toBe(2);
    expect(result.runsFreedSomething).toBe(2);
    expect(result.runsFreedNothing + result.runsFreedSomething).toBe(runs.length);
  });

  it('summarises bytes freed over only the runs that freed something', () => {
    const result = summariseFreed([0, 100, 300, 0, 200]);
    expect(result.bytesFreedWhenNonZero).toEqual({ count: 3, mean: 200, max: 300, min: 100 });
  });

  it('keeps the mean exact rather than rounding it', () => {
    expect(summariseFreed([3, 4]).bytesFreedWhenNonZero.mean).toBe(3.5);
  });

  it('reports a lone freeing run as its own mean, max and min', () => {
    expect(summariseFreed([0, 5000]).bytesFreedWhenNonZero).toEqual({
      count: 1,
      mean: 5000,
      max: 5000,
      min: 5000,
    });
  });
});

function record(bytesFreed: number, schemaVersion = 1): string {
  return JSON.stringify({
    schemaVersion,
    app: { version: '1.8.1' },
    scan: { pendingReboot: 'clean' },
    operation: {
      kind: 'delete',
      outcome: bytesFreed > 0 ? 'complete' : 'noFiles',
      bytesFreed,
    },
  });
}

describe('aggregate', () => {
  beforeEach(() => {
    blobState.blobs.clear();
  });

  it('counts only schemaVersion 1 records', async () => {
    blobState.blobs.set('v1/a.json', record(3072));
    blobState.blobs.set('v1/b.json', record(0));
    blobState.blobs.set('v1/c.json', record(1024, 2));
    const stats = await aggregate();
    expect(stats.totalRuns).toBe(2);
  });

  it('reports the freed-nothing and freed-something split', async () => {
    blobState.blobs.set('v1/a.json', record(3072));
    blobState.blobs.set('v1/b.json', record(0));
    blobState.blobs.set('v1/c.json', record(1024));
    const stats = await aggregate();
    expect(stats.runsFreedNothing).toBe(1);
    expect(stats.runsFreedSomething).toBe(2);
  });

  it('summarises bytes freed across the freeing runs', async () => {
    blobState.blobs.set('v1/a.json', record(3072));
    blobState.blobs.set('v1/b.json', record(0));
    blobState.blobs.set('v1/c.json', record(1024));
    const stats = await aggregate();
    expect(stats.bytesFreedWhenNonZero).toEqual({ count: 2, mean: 2048, max: 3072, min: 1024 });
    expect(stats.totalBytesFreed).toBe(4096);
  });

  it('keeps the freed buckets summing to totalRuns', async () => {
    for (let i = 0; i < 5; i++) {
      blobState.blobs.set(`v1/${i}.json`, record(i * 1000));
    }
    const stats = await aggregate();
    expect(stats.runsFreedNothing + stats.runsFreedSomething).toBe(stats.totalRuns);
  });
});
