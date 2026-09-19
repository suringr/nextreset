/**
 * Generate /play/ — the arcade route, ONE SHOT // 80 CONTRACTS.
 *
 *   npm run play:apply     then chrome:apply and design:apply, as after every page generator
 *
 * The page is the approved prototype's page: one canvas filling the screen under a bar, a FIRE button,
 * and a single line of instructions. Its markup follows the prototype element for element — the same
 * ids, the same text — with the shared NextReset header where the prototype had its own. The game is
 * `/assets/one-shot.js` and its stylesheet is `ONE_SHOT_CSS` in `design/tokens.ts`; `one-shot.test.ts`
 * holds the script, the stylesheet and this markup to the prototype.
 *
 * Three things about this page are deliberate and are enforced by tests rather than by memory.
 *
 * It carries NO AdSense loader. Every other content page does. `/play/` is an interactive surface where
 * a mis-tap costs a contract, and Google's Auto ads place anchors and vignettes over the viewport at the
 * account's discretion — which this repository cannot see or control. `carriesLoader` excludes it by
 * name, next to the 404 page, for reasons that are written down in adsense.ts.
 *
 * It declares `noindex, follow`. It is one canvas and one line of text, which is thin by the only measure
 * an index applies, and the site was rejected once for thin content.
 *
 * It has no breadcrumb and no footer. Every other page carries both; this one is a full-screen game that
 * does not scroll, as the owner approved, and has nowhere to put them. The shared header's "Trackers"
 * link reaches every tracker in one tap. `navigation.test.ts` exempts this page by name.
 */
import * as fs from "fs";
import * as path from "path";
import { chromeHtml } from "./design/chrome";
import { ONE_SHOT_NAME } from "./design/one-shot";
import { criticalCss } from "./design/tokens";

const publicDir = path.join(__dirname, "../public");

export const PLAY_PATH = "play/index.html";
export const PLAY_URL = "https://nextreset.co/play/";

/**
 * The prototype's one line of instructions, shown on a desktop. "R to reload" rather than its "R to
 * restart": R did restart the contract, which was the bug the owner approved fixing, and it now reloads.
 */
export const HINT = "Aim with mouse • FIRE / click / Space to shoot • R to reload";

const DESCRIPTION = "ONE SHOT // 80 CONTRACTS is a free sniper arcade game in the browser. Find the courier with the red case, stop the armed threat before he fires, and work through eighty contracts. Progress stays on this device.";

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generatePlayPage(): string {
    const title = `${ONE_SHOT_NAME} - NextReset Arcade`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${escapeHtml(DESCRIPTION)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="Find the courier, stop the armed threat, clear eighty contracts. A free sniper arcade game in the browser.">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://nextreset.co/og.png">
  <link rel="canonical" href="${PLAY_URL}">
  <meta name="robots" content="noindex, follow">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#050812">

  <!-- CRITICAL: Inline CSS for guaranteed first paint -->
  <style>
    ${criticalCss("play")}
  </style>

  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YY6V5SR1DN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', 'G-YY6V5SR1DN');
  </script>

  <!-- No AdSense loader on this page. See carriesLoader in scripts/adsense.ts: this is an interactive
       surface, and an Auto ads anchor or vignette over the game is a mis-tap that costs a contract. -->
</head>
<body>
  <div id="app">
${chromeHtml({ section: "arcade", title: ONE_SHOT_NAME, indent: "    " })}
    <canvas id="game" role="img" aria-label="ONE SHOT game: a street crowd at dusk seen through a rifle scope. Aim with the mouse or a finger, and shoot with FIRE, a click or Space."></canvas>
  </div>
  <button id="fire">FIRE</button>
  <div id="hint">${escapeHtml(HINT)}</div>
  <div id="best"></div>

  <noscript>
    <div class="noscript-note">
      <p>ONE SHOT needs JavaScript to run. Everything else on this site works without it &mdash;
      <a href="/">the trackers</a> carry their verified dates in the page itself.</p>
    </div>
  </noscript>

  <script src="/assets/player.js" defer></script>
  <script src="/assets/one-shot.js" defer></script>
</body>
</html>
`;
}

if (require.main === module) {
    const file = path.join(publicDir, PLAY_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generatePlayPage(), "utf-8");
    console.log(`✓ Generated ${PLAY_PATH}`);
}
