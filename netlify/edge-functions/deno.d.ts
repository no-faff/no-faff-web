// The edge functions run on Deno, not Node: Netlify's edge runtime provides
// `Deno` as a global, and this project's tsconfig extends astro/tsconfigs/strict
// for a Node and browser world that has never heard of it. Without this, every
// `astro check` reports three errors that are not defects, which is worse than
// no check at all because the real ones hide among them.
//
// Only the surface these functions actually call is declared. Pulling in the
// whole Deno namespace would assert that every Deno API is available here, which
// is a claim nothing has established and which would let a genuine mistake, a
// call to something the edge runtime does not expose, typecheck cleanly.
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};
