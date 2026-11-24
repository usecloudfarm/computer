#!/usr/bin/env node
/**
 * Renders `public/og.png`, the card every link to the docs unfurls into.
 *
 *   pnpm --filter @cloudfarm/docs gen:og
 *
 * A generator rather than a committed design file, for the same reason the
 * integrations are generated: the card repeats the mark, the title and the
 * description that already exist in `astro.config.mjs`, and a hand-made PNG
 * would be the copy that goes stale when one of them changes.
 *
 * Headless Chrome rather than an image library: the card is a layout — a
 * webfont stack, a radial gradient, a flex row of pills — and the browser
 * already does all of that correctly at a known size. Chrome ships on the
 * machines that build this, and the output is checked in, so a contributor
 * without it can still build the site.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** og:image is 1200x630 everywhere that matters — X, Slack, iMessage, LinkedIn. */
const WIDTH = 1200;
const HEIGHT = 630;

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/**
 * The mark, straight out of the site's own asset.
 *
 * It is drawn in `currentColor`, which is why nothing here sets a fill: the
 * card's text colour paints it, exactly as the site header does.
 */
function mark() {
  return readFileSync(join(ROOT, "src/assets/logo.svg"), "utf8").replace(
    "<svg",
    '<svg class="mark"',
  );
}

function html() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        background: #0b0d13;
        color: #ffffff;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 72px 80px;
        position: relative;
        overflow: hidden;
      }
      /* One accent, used once — the same restraint the docs theme is built on. */
      .glow {
        position: absolute;
        width: 900px;
        height: 900px;
        right: -320px;
        top: -420px;
        background: radial-gradient(circle, rgba(59, 130, 246, 0.28) 0%, rgba(59, 130, 246, 0) 62%);
      }
      .row { display: flex; align-items: center; gap: 20px; position: relative; }
      .mark { width: 64px; height: 64px; border-radius: 14px; }
      .wordmark { font-size: 40px; font-weight: 600; letter-spacing: -0.02em; }
      h1 {
        position: relative;
        font-size: 68px;
        line-height: 1.08;
        font-weight: 600;
        letter-spacing: -0.035em;
        max-width: 15ch;
      }
      h1 .dim { color: #7c8091; }
      .foot { display: flex; align-items: center; justify-content: space-between; position: relative; }
      .pills { display: flex; gap: 12px; }
      .pill {
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
        font-size: 22px;
        color: #bfdbfe;
        border: 1px solid rgba(59, 130, 246, 0.35);
        background: rgba(59, 130, 246, 0.08);
        border-radius: 999px;
        padding: 10px 22px;
      }
      .url { font-size: 24px; color: #7c8091; }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <div class="row">${mark()}<div class="wordmark">cloudfarm</div></div>
    <h1>A fast computer<br />with the right tools<br /><span class="dim">for every agent.</span></h1>
    <div class="foot">
      <div class="pills">
        <div class="pill">search</div>
        <div class="pill">code</div>
        <div class="pill">run</div>
      </div>
      <div class="url">cloudfarm.dev</div>
    </div>
  </body>
</html>`;
}

function chrome() {
  for (const path of CHROME) {
    try {
      execFileSync(path, ["--version"], { stdio: "ignore" });
      return path;
    } catch {
      // Next candidate.
    }
  }
  throw new Error(
    "No Chrome found. The card is checked in at public/og.png, so this is only needed to change it.",
  );
}

const directory = mkdtempSync(join(tmpdir(), "cloudfarm-og-"));
const page = join(directory, "og.html");
const shot = join(directory, "og.png");
writeFileSync(page, html());

execFileSync(
  chrome(),
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${shot}`,
    page,
  ],
  { stdio: "ignore" },
);

const out = join(ROOT, "public/og.png");
copyFileSync(shot, out);
process.stdout.write(`wrote ${out}\n`);
