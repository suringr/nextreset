/**
 * Generate /play/ — the arcade route.
 *
 * Generated rather than hand-written for the same reason the tracker pages are: the footer has to name
 * every tracker the site actually has, and a hand-maintained copy of that list is a list that goes
 * stale. It reads the same registry the tracker pages do.
 *
 *   npm run play:apply
 *
 * Two things about this page are deliberate and are enforced by tests rather than by memory.
 *
 * It carries NO AdSense loader. Every other content page does. `/play/` is an interactive surface where
 * a mis-tap is a lost life, and Google's Auto ads place anchors and vignettes over the viewport at the
 * account's discretion — which this repository cannot see or control. `carriesLoader` excludes it by
 * name, next to the 404 page, for reasons that are written down in adsense.ts.
 *
 * It declares `noindex, follow`. The page is worth crawling — it links to every tracker — and it is one
 * canvas and a set of instructions, which is thin by the only measure an index applies. The site was
 * rejected once for thin content, so the conservative side is the right side until the page has a
 * reason to be indexed.
 */
import * as fs from "fs";
import * as path from "path";
import { criticalCss } from "./design/tokens";
import { footerNavHtml, gamePages } from "./update-game-pages";

const publicDir = path.join(__dirname, "../public");

export const PLAY_PATH = "play/index.html";
export const PLAY_URL = "https://nextreset.co/play/";

/** The five missions, described from the same rules the game runs on. */
const MISSIONS: ReadonlyArray<{ name: string; objective: string; rule: string }> = [
    {
        name: "Quick Draw",
        objective: "Confirm 8 targets in 28 seconds",
        rule: "Contacts appear one or two at a time and break contact quickly. The exposure window narrows as you go, so the pressure comes from the window rather than from anything moving faster."
    },
    {
        name: "Hostage",
        objective: "Save 5 hostages in 40 seconds",
        rule: "A hostage is held on one side of the target, and the safe side is drawn as an arc you can see. Shoot the other side. A shot into the arc costs a life."
    },
    {
        name: "Sniper",
        objective: "Confirm 6 targets in 38 seconds",
        rule: "Contacts are distant and hard to tell apart. Scope to identify them — and lose everything outside the scope while you do. The tap area never shrinks below a finger's width, so this is an identification problem, not a dexterity one."
    },
    {
        name: "Crossfire",
        objective: "Confirm 10 targets in 45 seconds",
        rule: "Three lanes move at once and civilians cross in front of targets, so a contact you can see is not always a contact you have a shot at. Targets here shoot back: get into cover before the ring closes."
    },
    {
        name: "Boss",
        objective: "Break 3 phases in 60 seconds",
        rule: "Armoured and behind cover. It exposes for a moment, you fire, it answers — expose, fire, cover, reload. Four hits break a phase."
    }
];

const CONTROLS: ReadonlyArray<{ action: string; touch: string; keyboard: string }> = [
    { action: "Fire", touch: "Tap the contact", keyboard: "F or Enter" },
    { action: "Aim", touch: "Tap where you want to shoot", keyboard: "Arrow keys or WASD" },
    { action: "Scope", touch: "Tap SCOPE to latch it on", keyboard: "Hold Shift" },
    { action: "Cover", touch: "Tap COVER to latch it on", keyboard: "Hold C" },
    { action: "RESET MODE", touch: "Tap RESET when the meter is full", keyboard: "Space" },
    { action: "Pause", touch: "Tap PAUSE", keyboard: "P" }
];

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function missionsHtml(): string {
    return MISSIONS.map(m => `        <div class="mission">
          <h3 class="mission-name">${escapeHtml(m.name)}</h3>
          <p class="mission-objective">${escapeHtml(m.objective)}</p>
          <p>${escapeHtml(m.rule)}</p>
        </div>`).join("\n");
}

function controlsHtml(): string {
    return CONTROLS.map(c => `            <tr><th scope="row">${escapeHtml(c.action)}</th><td>${escapeHtml(c.touch)}</td><td>${escapeHtml(c.keyboard)}</td></tr>`).join("\n");
}

export function generatePlayPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="description" content="RESET//SCOPE is a five-mission arcade identification shooter you can play in the browser while you wait for a patch. Confirm targets, protect everyone else.">
  <meta property="og:title" content="RESET//SCOPE - NextReset Arcade">
  <meta property="og:description" content="A five-mission arcade identification shooter. Confirm targets, protect everyone else.">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://nextreset.co/og.png">
  <link rel="canonical" href="${PLAY_URL}">
  <meta name="robots" content="noindex, follow">
  <title>RESET//SCOPE - NextReset Arcade</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#050812">

  <!-- CRITICAL: Inline CSS for guaranteed first paint -->
  <style>
    ${criticalCss("play")}
  </style>

  <link rel="stylesheet" href="/assets/styles.v2.css">

  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YY6V5SR1DN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', 'G-YY6V5SR1DN');
  </script>

  <!-- No AdSense loader on this page. See carriesLoader in scripts/adsense.ts: this is an interactive
       surface, and an Auto ads anchor or vignette over the board is a mis-tap that costs a life. -->

  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://nextreset.co/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": "Arcade: RESET//SCOPE"
        }
      ]
    }
    </script>
</head>
<body>
  <div class="container">
    <div class="page">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a>
        <span class="crumb-sep" aria-hidden="true">&rsaquo;</span>
        <span aria-current="page">Arcade: RESET//SCOPE</span>
      </nav>

      <div class="game-header">
        <h1 class="game-title">RESET//SCOPE</h1>
        <div class="game-meta">
          <span class="kicker">NextReset Arcade</span>
        </div>
      </div>

      <p class="sub">Five missions. Confirm the targets, protect everyone else. It runs in this page and keeps your records on this device.</p>

      <!-- The board. Sized from its own box at every change, so the same run plays the same on a phone
           and a desktop; nothing here assumes a pixel size. -->
      <div class="play">
        <div class="hud" role="group" aria-label="Run status">
          <div class="hud-cell"><small>Score</small><b id="hud-score">0</b></div>
          <div class="hud-cell"><small>Mission</small><b id="hud-mission">&mdash;</b></div>
          <div class="hud-cell"><small id="hud-objective-label">Objective</small><b id="hud-objective">&mdash;</b></div>
          <div class="hud-cell"><small>Time</small><b id="hud-clock">&mdash;</b></div>
          <div class="hud-cell"><small>Lives</small><b id="hud-lives">&hearts;&hearts;&hearts;</b></div>
          <div class="hud-cell"><small>Ammo</small><b id="hud-ammo">6/6</b></div>
          <div class="hud-cell"><small>Combo</small><b id="hud-combo">&times;1</b></div>
        </div>

        <div class="stage" id="stage" tabindex="0" role="application" aria-label="RESET//SCOPE game board">
          <canvas id="board" aria-label="Game board. Use the controls below, or arrow keys to aim and F to fire."></canvas>
          <div class="overlay" id="overlay">
            <div class="overlay-panel">
              <h2 id="overlay-title">RESET//SCOPE</h2>
              <div id="overlay-body"></div>
              <button type="button" class="btn btn-primary" id="overlay-action">Start run</button>
            </div>
          </div>
        </div>

        <div class="meter" aria-hidden="true"><i id="hud-meter"></i></div>

        <div class="controls" role="group" aria-label="Game controls">
          <button type="button" class="control" id="control-scope" aria-pressed="false">SCOPE</button>
          <button type="button" class="control" id="control-cover" aria-pressed="false">COVER</button>
          <button type="button" class="control control-reset" id="control-reset" disabled>RESET 0%</button>
          <button type="button" class="control control-pause" id="control-pause">PAUSE</button>
        </div>

        <p class="visually-hidden" id="game-status" role="status" aria-live="polite"></p>
      </div>

      <section class="section">
        <h2 class="section-heading">Your records on this device</h2>
        <div class="records">
          <div class="record"><small>High score</small><b id="record-score">0</b></div>
          <div class="record"><small>Missions cleared</small><b id="record-mission">0</b></div>
          <div class="record"><small>Best rank</small><b id="record-rank">&mdash;</b></div>
          <div class="record"><small>Runs played</small><b id="record-played">0</b></div>
        </div>
        <p class="data-note">Kept in this browser only. There is no account, no server and no leaderboard &mdash; so there is no global ranking to show you, and we are not going to invent one.</p>
      </section>

      <div class="content-section">
        <h2>How to play</h2>
        <p>Tap or click a contact to fire at it. A target is a hard-edged diamond; a civilian is a circle with an open line. Shooting a civilian, or the hostage a target is holding, costs a life. Every mission ends when its objective is met &mdash; not when a clock runs out, which is only there to fail you.</p>
        <div class="table-wrap">
          <table class="controls-table">
            <thead><tr><th scope="col">Action</th><th scope="col">Touch</th><th scope="col">Keyboard</th></tr></thead>
            <tbody>
${controlsHtml()}
            </tbody>
          </table>
        </div>
      </div>

      <div class="content-section">
        <h2>Scope and cover are trades, not buttons</h2>
        <p><strong>Scope</strong> widens your hit area by about a third and makes a bullseye far easier &mdash; and it takes away the rest of the board. While it is on, anything outside the scope circle is neither drawn nor hittable. It is worth it when you need to tell a target from a civilian at distance, and it will cost you the contact arriving behind you.</p>
        <p><strong>Cover</strong> reloads roughly four times faster and stops incoming fire, and you cannot shoot from it. Outside cover a magazine still refills, slowly, so cover is a choice about tempo rather than something you are forced into. It dims the board; it does not blind you.</p>
      </div>

      <div class="content-section">
        <h2>RESET MODE</h2>
        <p>The meter fills from skill, not from time: a clean hit charges it, a bullseye charges it more, a quick confirm and a hostage save more again. At 100% you can spend it. For four and a half seconds the world runs at 45% speed, your hit area widens, and the score multiplier goes to 1.5&times;.</p>
        <p>It is deliberately not a bigger multiplier. RESET MODE should be worth using for what it does to time and precision &mdash; the moment where a mission you were losing becomes readable &mdash; rather than for the points. The combo caps at &times;8 for the same reason.</p>
      </div>

      <div class="content-section">
        <h2>The five missions</h2>
        <div class="missions">
${missionsHtml()}
        </div>
      </div>

      <div class="content-section">
        <h2>Scoring</h2>
        <ul>
          <li>A confirmed target is worth 100, plus up to 100 more for how centred the shot was.</li>
          <li><strong>Quickshot</strong> adds 60 when you confirm a contact within half a second of it appearing.</li>
          <li><strong>Bullseye</strong> adds 80 for a shot in the middle of the target.</li>
          <li><strong>Hostage save</strong> adds 200.</li>
          <li><strong>Multikill</strong> adds a flat 150 for three confirms inside 1.6 seconds.</li>
          <li>The total is multiplied by your combo, up to &times;8, and by 1.5&times; during RESET MODE.</li>
          <li>A miss costs 15 and resets the combo. So does letting a target break contact.</li>
        </ul>
        <p>Rank comes from the score alone, so the end screen can tell you how it was worked out: S at 26,000, A at 16,000, B at 9,000, C at 4,000, D below that.</p>
      </div>

      <div class="content-section">
        <h2>Accessibility</h2>
        <ul>
          <li>The game is fully playable from the keyboard: arrows or WASD to aim, F or Enter to fire, Shift to scope, C for cover, Space for RESET MODE, P to pause. Those keys only act while the board has focus, so the rest of this page scrolls normally.</li>
          <li>Targets and civilians differ in <em>shape</em> as well as colour, and the hostage's safe side is drawn as an arc rather than being something you learn by losing.</li>
          <li>Every hit area is at least 44&nbsp;CSS pixels across however small the contact is drawn, so difficulty comes from exposure, identification and timing rather than from precision your device cannot give you.</li>
          <li>With <code>prefers-reduced-motion</code> set, the screen does not flash, floating score does not drift, and nothing pulses. Scoring is unchanged.</li>
          <li>The run pauses when you switch tabs, rotate the device or leave the window, and never resumes without you asking it to.</li>
        </ul>
      </div>

      <div class="content-section">
        <h2>Why a game is on a tracker site</h2>
        <p>NextReset exists to tell you when something is happening. The honest answer is often "in four days", and there is nothing to do with that answer but come back later. RESET//SCOPE is what there is to do in the meantime. It does not touch the tracked data, it is not loaded on any other page, and none of it is on the homepage except three numbers.</p>
        <p><a href="/">Back to the command center</a> for what is actually coming.</p>
      </div>
    </div>

    <noscript>
      <div class="noscript-note">
        RESET//SCOPE needs JavaScript to run. Everything the rest of the site publishes works without it &mdash;
        <a href="/">the trackers</a> carry their verified dates in the page itself.
      </div>
    </noscript>

    <footer>
      ${footerNavHtml(gamePages)}
      <p>Checked automatically several times a day against official sources.</p>
      <p>Not affiliated with any game publishers. All trademarks belong to their respective owners.</p>
      <p><a href="/about/">About</a> &middot; <a href="/privacy/">Privacy Policy</a></p>
    </footer>
  </div>

  <script src="/assets/player.js" defer></script>
  <script src="/assets/scope-core.js" defer></script>
  <script src="/assets/scope.js" defer></script>
  <script src="/assets/scope-play.js" defer></script>
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
