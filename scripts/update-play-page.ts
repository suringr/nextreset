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
 * It used to declare `noindex, follow`, because it was one canvas and one line of text, which is thin by any measure
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


/**
 * What the page says about the game, below it.
 *
 * Here as well as in the checked-in page, because `play:apply` regenerates that file wholesale: a
 * version of this that lived only in the output would be deleted the next time anyone ran the
 * documented command, silently and completely (Codex, #72).
 */
const PROSE = `  <!-- Below the game, so the game is still the whole of the first screen. This is for the questions a
       player has once they have put it down. Every number here comes from one-shot.js and player.js
       rather than from memory, and a test holds the two together so the page cannot go on describing a
       game that has changed. -->
  <div class="play-page" id="how-to-play">
      <h2>What ONE SHOT is</h2>
      <p>A sniper arcade game that lives on this site. You watch a street crowd through a scope, and each
        contract gives you one job: find the right person and take the shot before the clock runs out.
        There are eighty of them. It is free, it runs in the browser, and there is no account to make and
        nothing to install.</p>
      <p>It was built for this site rather than licensed into it, which is also why it carries no
        advertising of any kind &mdash; not a banner, not a unit, not even the loader script. A game is a
        bad place to put something a player might hit by accident.</p>

      <h2>Controls</h2>
      <ul>
        <li><strong>Aim</strong> &mdash; move the mouse, or drag with a finger on a touchscreen.</li>
        <li><strong>Shoot</strong> &mdash; click, press <kbd>Space</kbd>, or use the round <strong>FIRE</strong> button.</li>
        <li><strong>Reload</strong> &mdash; press <kbd>R</kbd>. From contract 11 you carry more than one
          round, and running dry halfway through is the usual way to lose one.</li>
      </ul>

      <h2>What the eighty contracts ask</h2>
      <p>They are not eighty variations of the same thing. What you are hunting changes, and so does how
        much room you have to find it:</p>
      <ul>
        <li><strong>1&ndash;10</strong> &mdash; find the courier carrying the red case. One round only: no
          reload, no second chance.</li>
        <li><strong>11&ndash;30</strong> &mdash; track the moving target, and reload when you run empty.
          Three rounds.</li>
        <li><strong>31&ndash;40</strong> &mdash; find the armed hostile before he fires at you. Three rounds.</li>
        <li><strong>41&ndash;60</strong> &mdash; precision under pressure. Four rounds.</li>
        <li><strong>61&ndash;70</strong> &mdash; elite contracts, with faster targets.</li>
        <li><strong>71&ndash;80</strong> &mdash; master contracts: survive, then clear the threat.</li>
      </ul>
      <p>Three things tighten as you go, which is what makes the late contracts hard rather than merely
        longer. The time limit falls from twenty seconds to fourteen. The crowd grows from five people to
        eleven, so there is more to look through. And from contract 31 the hostile shoots back, sooner and
        sooner: early on he takes roughly six to eight seconds, and by the last contracts between three
        and six. He does not take the same time twice, so late contracts are a question of being ready
        rather than of counting.</p>

      <h2>Stars, XP and ranks</h2>
      <p>Each contract is worth up to three stars, and the game keeps the best you have managed on each
        one, so going back to a contract you scraped through is worth doing. XP accumulates across
        everything you play, and a rank arrives every 8,000 XP:</p>
      <p><strong>Recruit &rarr; Rookie &rarr; Marksman &rarr; Sharpshooter &rarr; Hunter &rarr; Operative
        &rarr; Elite &rarr; Ghost &rarr; Master Sniper.</strong></p>
      <p>For scale: clearing contract 80 on a streak is worth roughly 100,000 XP, and a perfect run of all
        eighty about four million.</p>

      <h2>Where your progress is kept</h2>
      <p>On your device, in this browser, and nowhere else. There is no account and no save to the cloud,
        so the game picks up at the highest contract you have unlocked whenever you come back to it in the
        same browser.</p>
      <p>The other side of that is worth knowing before you sink an evening into it: clearing this site's
        data, playing in a private window, or opening the game on another device starts you again at
        contract one. Nothing is lost from anywhere else, because it was never anywhere else.</p>
  </div>`;

/** VideoGame, beside the breadcrumb rather than instead of it. */
const GAME_SCHEMA = `  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "VideoGame",
      "name": "ONE SHOT // 80 CONTRACTS",
      "url": "https://nextreset.co/play/",
      "description": "A free sniper arcade game in the browser. Find the courier with the red case, stop the armed hostile before he fires, and work through eighty contracts. Progress is kept on your own device.",
      "genre": ["Arcade", "Shooter"],
      "gamePlatform": "Web browser",
      "playMode": "SinglePlayer",
      "applicationCategory": "Game",
      "operatingSystem": "Any",
      "inLanguage": "en",
      "isAccessibleForFree": true,
      "author": { "@type": "Organization", "name": "NextReset", "url": "https://nextreset.co/" },
      "publisher": { "@type": "Organization", "name": "NextReset", "url": "https://nextreset.co/" },
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD", "availability": "https://schema.org/InStock" }
    }
  </script>`;

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
${GAME_SCHEMA}
</head>
<body>
  <div id="app">
${chromeHtml({ section: "arcade", title: ONE_SHOT_NAME, indent: "    " })}
    <canvas id="game" role="img" aria-label="ONE SHOT game: a street crowd at dusk seen through a rifle scope. Aim with the mouse or a finger, and shoot with FIRE, a click or Space."></canvas>
    <button id="fire">FIRE</button>
    <div id="hint">${escapeHtml(HINT)}</div>
    <div id="best"></div>
  </div>
  <a class="play-more" href="#how-to-play">How to play &darr;</a>
${PROSE}

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
