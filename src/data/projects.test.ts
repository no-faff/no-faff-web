import { describe, it, expect } from 'vitest';
import { projects, getProject } from './projects';

describe('projects metadata', () => {
  it('lists every project with required fields', () => {
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p.slug).toMatch(/^[a-z0-9-]+$/);
      expect(p.name).toBeTruthy();
      expect(p.tier === 1 || p.tier === 2).toBe(true);
      expect(['shipped', 'in-development', 'planning']).toContain(p.status);
      expect(p.oneLiner.length).toBeGreaterThan(10);
      expect(p.homepage.startsWith('/')).toBe(true);
      expect(p.github.startsWith('https://github.com/')).toBe(true);
    }
  });

  it('exposes installerclean as Tier 1 shipped', () => {
    const ic = getProject('installerclean');
    expect(ic).toBeDefined();
    expect(ic?.tier).toBe(1);
    expect(ic?.status).toBe('shipped');
  });

  it('returns undefined for unknown slugs', () => {
    expect(getProject('nope')).toBeUndefined();
  });
});
