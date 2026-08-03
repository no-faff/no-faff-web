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
//
// It sits here rather than beside the functions it describes, and that is not
// tidiness. Netlify bundles every top-level file in netlify/edge-functions as an
// edge function and judges each one by its default export, so a declaration file
// in there failed the whole deploy with "Default export ... must be a function"
// while the site itself built clean and said so. tsconfig sets no `include`, so
// TypeScript takes every file under the repo and an ambient declaration is found
// wherever it sits.
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};
