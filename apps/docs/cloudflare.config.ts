import { defineConfig, triggers } from "cf/config";

/**
 * The docs site, as an assets-only Worker.
 *
 * No `entrypoint`: every page is prerendered, so there is no code to run and
 * the edge serves the files directly. Deploy with the directory form —
 * `cf deploy ./dist` — which skips the build. Without the directory, `cf`
 * detects Astro and builds it again through the Cloudflare adapter, which
 * this site does not need and which fails on a transitive wasm import.
 *
 * The zone already carries proxied `AAAA 100::` placeholders for the apex and
 * `www`, which is what a route attaches to.
 */
export default defineConfig({
  worker: {
    name: "cloudfarm-docs",
    compatibilityDate: "2026-11-24",
    // Astro writes a real 404 page; without this a bad path gets an empty
    // body from the asset worker rather than the site's own.
    assets: { notFoundHandling: "404-page" },
    triggers: [
      triggers.fetch({ pattern: "cloudfarm.dev/*", zone: "cloudfarm.dev" }),
      triggers.fetch({ pattern: "www.cloudfarm.dev/*", zone: "cloudfarm.dev" }),
    ],
  },
});
