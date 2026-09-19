/**
 * The site's palette, type and geometry — the approved demo's, declared once and consumed everywhere.
 *
 * The demo (NEXT//RESET Command Center: its homepage and its tracker page) is the visual source of
 * truth. V4 had built its own system beside it — one radius and one drop shadow on every card, a
 * monospace face for every number, 11px letter-spaced labels, tinted pill badges — and production did not
 * look like the design that was approved. Every value below is the demo's own, under a name, so the
 * stylesheet can port the demo's rules as written rather than approximate them.
 *
 * Two values are not the demo's, and each says why beside it: `--cta-to`, the blue end of the primary
 * button, is the demo's blue scaled 3.5% darker, same hue, so white text clears AA across the whole button;
 * and the demo has no word for the "unavailable" state, so the site keeps its own.
 *
 * Every colour is a token because a colour written inline is one no contrast test can find. Every text
 * token is checked against every surface it sits on by design-tokens.test.ts.
 *
 * The CSS itself lives in two places, both generated or checked from here: `styles.v2.css`, with the
 * `:root` block written from TOKENS, and the inline critical CSS of every page, from `criticalCss()`.
 */

/** Every custom property, in the order the `:root` block declares them. */
export const TOKENS: ReadonlyArray<readonly [string, string, string]> = [
    // name, value, why it exists
    ["--ground", "#050812", "the page itself (the demo's --bg)"],
    ["--surface", "#0b1325", "a panel, and the open menu (--panel)"],
    ["--surface-2", "#101a31", "the top of a game card's gradient (--panel2)"],
    ["--line", "#26395f", "the edge of the hero and of a game card (--line)"],

    ["--ink", "#f5f7ff", "anything a reader is meant to read (--text)"],
    ["--ink-muted", "#91a1bd", "supporting text (--muted)"],
    ["--nav-ink", "#c2cce0", "the header's links"],
    ["--eyebrow", "#c2adff", "the small violet label above a heading"],
    ["--hero-sub", "#b6c2d8", "the line under the hero's title"],
    ["--meta", "#aebbd0", "the hero's trust row, and a card's checked time"],
    ["--link", "#78c3ff", "a link that is not a button: \"All 12 →\", a source"],
    ["--footer-ink", "#8f9db6", "the footer"],

    ["--brand", "#8b5cf6", "NextReset's violet: the // in the wordmark, the next dot on a timeline (--violet)"],
    ["--brand-bright", "#b69dff", "the focus ring"],
    ["--state-verified", "#34d399", "● LIVE, and the entry a timeline is waiting for (--green)"],
    ["--state-stale", "#fbbf24", "● STALE (--amber)"],
    ["--state-unavailable", "#9fb0c9", "● UNAVAILABLE: the demo has no such state, so this one is the site's"],

    ["--bar", "#050812e8", "the sticky header's glass"],
    ["--bar-line", "#17243c", "the rule under the header"],
    ["--control", "#0b1427", "a button, the player chip, the menu"],
    ["--control-line", "#31466f", "their edge"],
    ["--cta-from", "#8b3dff", "the primary button's gradient, violet end"],
    ["--cta-to", "#4c61f6", "and its blue end: the demo's #4f65ff leaves white text at 4.23:1; scaled 3.5% darker, same hue, the whole button clears 4.5:1"],

    ["--hero-veil-from", "#07101ff5", "the veil across the hero, left"],
    ["--hero-veil-to", "#07101fb8", "and right, where the glow shows through"],
    ["--hero-glow", "#315cad", "the blue light behind the hero"],
    ["--hero-mid", "#111a3a", "its falloff"],
    ["--hero-deep", "#080d18", "its edge"],
    ["--tile", "#070d19d9", "a countdown tile"],
    ["--tile-line", "#2d426c", "its edge"],
    ["--tile-ink", "#bea5ff", "its digits"],
    ["--tile-label", "#67c9ff", "its unit"],

    ["--card-foot", "#09111f", "the bottom of a game card's gradient"],
    ["--star", "#0a1223", "a card's track box"],
    ["--star-line", "#354b76", "its edge"],
    ["--star-on", "#ffd25c", "a tracked star"],

    ["--deep-from", "#0d1730", "the dark start of the arcade card's and the tracker hero's gradients"],
    ["--arcade-to", "#080e1b", "the arcade card's gradient end"],
    ["--arcade-line", "#3a3c76", "the arcade card's edge, and the arcade strip's"],
    ["--arcade-glow", "#6633aa55", "the violet light in the arcade card"],
    ["--stat", "#091222", "an arcade record tile, and an evidence row"],
    ["--stat-line", "#2b3d62", "an arcade record tile's edge"],
    ["--rule", "#182740", "a divider between rows"],
    ["--rule-soft", "#17243b", "the rules around the features strip"],

    ["--tracker-to", "#08101e", "the tracker hero's gradient end"],
    ["--rail", "#283d63", "a timeline's rail"],
    ["--dot", "#536784", "a timeline entry that is not the next one"],
    ["--row-line", "#203455", "an evidence row's edge"],
    ["--arc-from", "#111630", "the arcade strip's gradient start"],
    ["--arc-to", "#09101e", "and its end"],

    ["--glow-blue", "#19366b66", "the blue light at the top right of every page"],
    ["--glow-violet", "#37145344", "the violet light at the left"],

    ["--r-hero", "16px", "the homepage hero"],
    ["--r-panel", "15px", "the arcade card and the tracker hero"],
    ["--r-strip", "13px", "the arcade strip"],
    ["--r-card", "12px", "a game card"],
    ["--r-control", "10px", "a button, the chip, an evidence row"],
    ["--r-tile", "9px", "a countdown tile, a record tile"],
    ["--r-star", "8px", "a card's track box"],

    ["--font", "system-ui, -apple-system, Segoe UI, sans-serif", "everything, numbers included: the demo sets no second face"],
    ["--size-small", "13px", "supporting prose the demo does not show"],

    ["--sp-1", "4px", ""],
    ["--sp-2", "8px", ""],
    ["--sp-3", "12px", ""],
    ["--sp-4", "16px", ""],
    ["--sp-5", "24px", ""],

    ["--gutter", "9px", "the side margin on a phone: the demo's min(100% - 18px, 620px). 12px from 701px"],
    ["--measure", "68ch", "how wide running text is allowed to get"],
    ["--tap", "44px", "the smallest interactive target, per WCAG 2.5.5 — kept however small the demo draws it"]
];

/** Token name to value, for tests and for anything that needs one colour by name. */
export const TOKEN: Record<string, string> = Object.fromEntries(TOKENS.map(([name, value]) => [name, value]));

/**
 * Which tokens carry text, what they sit on, and how big they get.
 *
 * The pairing is declared rather than inferred, because "is this readable" has no answer without
 * knowing the surface. Translucent surfaces are checked through the opaque surface they are laid on.
 */
export const TEXT_ON_SURFACE: ReadonlyArray<{ ink: string; on: string[]; minimum: number; note: string }> = [
    { ink: "--ink", on: ["--ground", "--surface", "--surface-2", "--control", "--stat", "--card-foot", "--deep-from", "--arc-from"], minimum: 4.5, note: "body and headings" },
    { ink: "--ink-muted", on: ["--ground", "--surface", "--surface-2", "--stat", "--card-foot", "--deep-from", "--arc-from"], minimum: 4.5, note: "supporting text" },
    { ink: "--nav-ink", on: ["--ground", "--surface", "--control"], minimum: 4.5, note: "the header's links, and the open menu" },
    { ink: "--eyebrow", on: ["--ground", "--surface", "--deep-from", "--arc-from"], minimum: 4.5, note: "labels at 10px" },
    { ink: "--hero-sub", on: ["--ground", "--surface"], minimum: 4.5, note: "the hero's subtitle" },
    { ink: "--meta", on: ["--ground", "--surface", "--surface-2", "--card-foot"], minimum: 4.5, note: "the trust row and a card's checked time, at 11px" },
    { ink: "--link", on: ["--ground", "--surface", "--stat"], minimum: 4.5, note: "a link" },
    { ink: "--footer-ink", on: ["--ground"], minimum: 4.5, note: "the footer" },
    { ink: "--tile-ink", on: ["--ground", "--surface"], minimum: 4.5, note: "countdown digits" },
    { ink: "--tile-label", on: ["--ground", "--surface"], minimum: 4.5, note: "countdown units at 8px" },
    { ink: "--star-on", on: ["--star"], minimum: 3, note: "a tracked star: a glyph, not text" },
    { ink: "--state-verified", on: ["--ground", "--surface", "--surface-2", "--card-foot", "--stat"], minimum: 4.5, note: "● LIVE" },
    { ink: "--state-stale", on: ["--ground", "--surface", "--surface-2", "--card-foot", "--stat"], minimum: 4.5, note: "● STALE" },
    { ink: "--state-unavailable", on: ["--ground", "--surface", "--surface-2", "--card-foot", "--stat"], minimum: 4.5, note: "● UNAVAILABLE and its sentence" },
    { ink: "--brand-bright", on: ["--ground", "--surface", "--surface-2"], minimum: 3, note: "the focus ring: a non-text indicator" },
    { ink: "--brand", on: ["--ground"], minimum: 3, note: "the // of a 20px heavy wordmark — large text" },
    // The primary button is a gradient; white text sits on every point of it. Checked at both ends — the
    // demo's own #4f65ff fails here at 4.23:1, which is why --cta-to is not quite the demo's value.
    { ink: "--ink", on: ["--cta-from", "--cta-to"], minimum: 4.5, note: "text on the primary button" }
];

/** The `:root` block, generated so the stylesheet and every page agree by construction. */
export function rootBlock(indent = ""): string {
    const lines = TOKENS.map(([name, value, why]) => `${indent}  ${name}: ${value};${why ? ` /* ${why} */` : ""}`);
    return [`${indent}:root {`, ...lines, `${indent}}`].join("\n");
}

/** The same block with the comments stripped, for the inline copy where every byte is on the wire. */
export function rootBlockCompact(): string {
    return `:root{${TOKENS.map(([name, value]) => `${name}:${value}`).join(";")}}`;
}

/** Which page a critical-CSS block is for. Each ships only what its own first paint needs. */
export type PageKind = "home" | "tracker" | "static" | "play";

/**
 * The header's own pieces — wordmark, links, player chip and the phone's menu — on every page, /play/
 * included. The bar they sit in is SITE's on every page but /play/, where it is ONE SHOT's.
 *
 * These rules live only here, in every page's inline CSS, not in the stylesheet: /play/ loads no
 * stylesheet, and one copy cannot drift from another.
 *
 * The phone's menu is the one place the site deliberately differs from the demo, which hides its links
 * below 700px and offers nothing in their place. The links are a native popover: no script, dismissed by
 * a tap outside or Escape, and announced as a collapsed control. A browser without popovers never hides
 * them — it never sees the rule that would — and shows the links inline, as the site always did.
 */
export const CHROME = [
    `*{box-sizing:border-box}`,
    `a{color:inherit;text-decoration:none}`,
    `h1,h2,h3{margin:0;text-wrap:balance}`,
    `.chrome-brand{display:inline-flex;align-items:center;min-height:var(--tap);font-weight:950;font-size:20px;letter-spacing:-1px;line-height:1.45;white-space:nowrap}`,
    `.chrome-brand i{font-style:normal;color:var(--brand)}`,
    // The popover's own defaults (fixed, centred, bordered, Canvas-coloured) are undone for the inline nav.
    `.chrome-nav{position:static;inset:auto;width:auto;height:auto;margin:0;padding:0;overflow:visible;border:0;background:none;display:flex;gap:18px;color:var(--nav-ink);font-size:15px}`,
    // The demo's links are 22px of text. The padding is the 44px target; the margin gives the room back.
    `.chrome-nav a{display:inline-flex;align-items:center;min-height:var(--tap);padding-inline:4px;margin-inline:-4px}`,
    `.chrome-player{margin:0;padding:8px 10px;border:1px solid var(--control-line);border-radius:var(--r-control);background:var(--control);color:var(--ink);font-size:12px;line-height:1.45;white-space:nowrap}`,
    `.chrome-player::before{content:"⚡ ";content:"⚡ " / ""}`,
    `.chrome-player[hidden]{display:none}`,
    // On a phone the chip and the menu button are one group at the right edge; above 700px the group
    // dissolves and they are the demo's header items again.
    `.chrome-end{display:flex;align-items:center;gap:18px;margin-left:auto}`,
    `.chrome-menu{display:none}`,
    `@supports selector(:popover-open){.chrome-menu{position:relative;z-index:1;display:inline-flex;flex:none;align-items:center;justify-content:center;width:var(--tap);height:var(--tap);margin:0 -4px 0 -12px;padding:0;border:0;background:none;color:var(--ink);cursor:pointer}.chrome-menu::before{content:"";position:absolute;inset:4px;z-index:-1;border:1px solid var(--control-line);border-radius:var(--r-control);background:var(--control)}.chrome-nav:not(:popover-open){display:none}}`,
    `.chrome-menu-icon,.chrome-menu-icon::before,.chrome-menu-icon::after{display:block;width:16px;height:2px;border-radius:1px;background:currentColor}`,
    `.chrome-menu-icon{position:relative}`,
    `.chrome-menu-icon::before,.chrome-menu-icon::after{content:"";position:absolute;left:0}`,
    `.chrome-menu-icon::before{top:-5px}`,
    `.chrome-menu-icon::after{top:5px}`,
    `.chrome-nav:popover-open{position:fixed;inset:69px 9px auto auto;min-width:190px;padding:6px;flex-direction:column;gap:2px;border:1px solid var(--control-line);border-radius:var(--r-control);background:var(--surface)}`,
    `.chrome-nav:popover-open a{margin:0;padding:0 12px;border-radius:var(--r-star)}`,
    `.chrome-nav:popover-open a:hover{background:var(--control)}`,
    // Where the browser can anchor it, the menu opens under its button, wherever the button is — including
    // on the second row of a bar that wrapped — the same distance below the bar as the fixed position. Elsewhere the fixed position above holds, which is
    // right whenever the bar is one row.
    `@supports (anchor-name:--a){.chrome-menu{anchor-name:--site-menu}.chrome .chrome-nav:popover-open{position-anchor:--site-menu;top:calc(anchor(bottom) + var(--menu-drop,16px));right:calc(anchor(right) + 4px);bottom:auto;left:auto}}`,
    `@media(min-width:701px){.chrome-end{display:contents}.chrome-menu{display:none}.chrome-nav:not(:popover-open){display:flex}.chrome-nav:popover-open{position:static;min-width:0;padding:0;flex-direction:row;gap:18px;border:0;background:none}.chrome-nav:popover-open a{padding:0 4px;margin:0 -4px}.chrome-player{padding:10px 13px;font-size:15px}}`
].join("");

/**
 * Every page but /play/: the demo's page — its ground, its type, its width — and its header bar.
 *
 * The demo's side margin is 9px on a phone and 12px from 701px, with the content capped at 620px and
 * 1160px. `.container` keeps the site's rule that the gutter is side padding set once, never a shorthand.
 *
 * The demo paints its two glows sized to the page, and its pages are 1,000–1,600px tall; these are
 * 3,700–5,400px, where the same gradient would be blown up three- or four-fold. The glows are sized to
 * the demo's own page instead, so the first screen matches it.
 */
const SITE = [
    `html{scroll-behavior:smooth}`,
    `body{margin:0;min-height:100vh;background-color:var(--ground);background-image:radial-gradient(circle at 75% 0,var(--glow-blue),transparent 28%),radial-gradient(circle at 10% 22%,var(--glow-violet),transparent 24%);background-size:100% 1616px;background-repeat:no-repeat;color:var(--ink);font:15px/1.45 var(--font);-webkit-text-size-adjust:100%}`,
    `button{font:inherit;color:inherit}`,
    `.wrap{width:min(calc(100% - 18px),620px);margin-inline:auto}`,
    `.container{width:100%;max-width:calc(620px + 2 * var(--gutter));margin:0 auto;padding-inline:var(--gutter);padding-block:0}`,
    `.top{position:sticky;top:0;z-index:20;background:var(--bar);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border-bottom:1px solid var(--bar-line)}`,
    `.nav{min-height:62px;display:flex;flex-wrap:wrap;align-items:center;gap:0 18px}`,
    `.nav .chrome-brand{margin-right:auto}`,
    `@media(min-width:701px){:root{--gutter:12px}.wrap{width:min(1160px,calc(100% - 24px))}.container{max-width:calc(1160px + 2 * var(--gutter))}body{background-size:100% 1262px}}`
].join("");

/** The homepage's first screen: the intro line and the hero, the demo's `.hero`. */
const HOME = [
    `.intro{margin:14px 0 0}`,
    `.h1{margin:0;font-size:15px;font-weight:700}`,
    `.sub{margin:2px 0 0;font-size:13px;color:var(--ink-muted);max-width:var(--measure)}`,
    `.drop{margin-top:12px;padding:22px;overflow:hidden;border:1px solid var(--line);border-radius:var(--r-hero);background:linear-gradient(90deg,var(--hero-veil-from),var(--hero-veil-to)),radial-gradient(circle at 80% 30%,var(--hero-glow),var(--hero-mid) 35%,var(--hero-deep) 70%)}`,
    `.drop-eyebrow,.eyebrow{margin:0;font-size:10px;font-weight:900;letter-spacing:1.7px;color:var(--eyebrow);text-transform:uppercase}`,
    `.drop-game{margin:8px 0 4px;font-size:34px;font-weight:700;letter-spacing:-1.5px;text-transform:uppercase}`,
    `.drop-topic{margin:0;color:var(--hero-sub)}`,
    `@media(min-width:760px){.drop{padding:34px;min-height:330px}.drop-game{font-size:46px}}`
].join("");

/** A tracker page's first screen: the demo's tracker hero. */
const TRACKER = [
    `.tracker-hero{margin-top:12px;padding:20px;border:1px solid var(--line);border-radius:var(--r-panel);background:linear-gradient(135deg,var(--deep-from),var(--tracker-to))}`,
    `.game-title{margin:7px 0;font-size:30px;font-weight:700;text-transform:uppercase}`,
    `.countdown-box{display:flex;flex-direction:column;margin:0}`,
    `.countdown-value{order:1;margin:12px 0;font-size:31px;font-weight:950;text-transform:uppercase;font-variant-numeric:tabular-nums;overflow-wrap:break-word}`,
    `.countdown-label{order:2;color:var(--ink-muted)}`
].join("");

/**
 * The arcade: ONE SHOT's own stylesheet, as the approved prototype wrote it.
 *
 * `ONE_SHOT_CSS` is the prototype's `<style>` block with the approved edits in `one-shot-approved.ts`
 * applied — the shared header in place of its own, the detailed status line over the game rather than
 * in the header — and `one-shot.test.ts` rebuilds it from the prototype and fails on any other
 * difference. Its colours are the game's and stay literal: they are the prototype's, not the site's
 * palette, and the canvas draws with the same values.
 *
 * /play/ loads no `styles.v2.css`. It would load after this block and override the game's own `body`
 * and layout rules, and the page needs nothing else from it; the few site rules it does need are
 * `PLAY_ADDITIONS`, listed on their own so they cannot be mistaken for the game's.
 */
export const ONE_SHOT_CSS = `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#071019;color:#fff;font-family:system-ui,Segoe UI,Arial}#app{height:100dvh;display:flex;flex-direction:column}header{min-height:52px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 14px;background:#07121b;border-bottom:1px solid #243441}.chrome-title{font-size:12px;font-weight:850;color:#38cfff}#best{position:fixed;left:14px;bottom:34px;font-size:12px;color:#9babb8;pointer-events:none}canvas{display:block;flex:1;width:100%;min-height:0;touch-action:none;cursor:none}#fire{position:fixed;right:20px;bottom:22px;width:106px;height:106px;border-radius:50%;border:7px solid rgba(255,255,255,.16);background:#c93037;color:#fff;font-weight:900;font-size:22px;box-shadow:0 0 0 4px rgba(201,48,55,.35),0 8px 30px #0008;touch-action:manipulation}#fire:active{transform:scale(.96)}#hint{position:fixed;left:14px;bottom:12px;color:#b7c4ce;font-size:12px;pointer-events:none}@media(max-width:700px){header{min-height:44px}.chrome-title{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}#best{bottom:14px}#fire{width:82px;height:82px;right:14px;bottom:14px;font-size:18px;border-width:5px}#hint{display:none}}`;

export const PLAY_ADDITIONS = [
    // The shared header's inner row is the site's page width; here the prototype's bar lays out the
    // wordmark, the game's name, the links and the chip itself, exactly as it laid out its own.
    `.chrome .nav{display:contents}`,
    // The prototype's bar held two things and spaced them apart; it now holds four, at the demo's gap.
    // It wraps rather than clip: on a 320px phone the wordmark, a player's chip and the menu are wider than
    // the bar, and the page does not scroll, so a menu pushed past the edge would be out of reach
    // (Codex, #63). From 390px they fit, and the bar stays the prototype's single row.
    `.chrome{flex-wrap:wrap;column-gap:18px;--menu-drop:8px}`,
    `.chrome-nav{margin-right:auto}`,
    `.chrome-player{margin-left:auto}`,
    // The wordmark's and the menu's 44px targets overhang the phone's 44px bar by its 1px rule rather
    // than growing it: the bar keeps the prototype's height to the pixel.
    `.chrome-brand,.chrome-menu{margin-block:-1px}`,
    // The phone's menu opens under this bar, which is ONE SHOT's 44px rather than the site's 62px.
    `.chrome-nav:popover-open{top:51px}`,
    // The site's line height is 1.55; the prototype ran on the browser's default, and its fixed lines of
    // text (the hint, the status line) sit where they did only at that height.
    `html,body{line-height:normal}`,
    // The site's focus ring, which every other page gets from styles.v2.css.
    `:focus-visible{outline:2px solid var(--brand-bright);outline-offset:2px}`,
    // Without JavaScript there is no game: the note covers the empty board and the FIRE button under the
    // header, rather than leaving a button that does nothing.
    `.noscript-note{position:fixed;top:52px;right:0;bottom:0;left:0;z-index:1;display:grid;place-content:center;padding:var(--sp-5);text-align:center;background:#071019;color:var(--ink-muted);font-size:var(--size-small)}`,
    `.noscript-note a{color:var(--link)}`,
    `@media(max-width:700px){.noscript-note{top:44px}}`
].join("");

const PLAY = ONE_SHOT_CSS + PLAY_ADDITIONS;

/** About, Privacy, 404: prose and a way back. */
const STATIC = [
    `.page{max-width:var(--measure)}`,
    `.page h1{margin:12px 0;font-size:30px;font-weight:700}`,
    `.page h2{margin:24px 0 12px;font-size:19px;font-weight:700}`,
    `.page p{margin:0 0 12px;color:var(--ink-muted)}`
].join("");

/**
 * The inline block a page ships for its first paint.
 *
 * Generated rather than authored, because the same rules were once maintained by hand in fifteen files.
 * `design-tokens.test.ts` asserts every page carries exactly what this function returns for it, and that
 * every page-kind rule here is also, word for word, a rule of the stylesheet.
 */
export function criticalCss(kind: PageKind): string {
    if (kind === "play") return rootBlockCompact() + CHROME + PLAY;
    const body = kind === "home" ? HOME : kind === "tracker" ? TRACKER : STATIC;
    return rootBlockCompact() + CHROME + SITE + body;
}

/** The page-kind rules of the critical CSS, which the stylesheet must carry too. */
export const CRITICAL_PAGE_RULES: Readonly<Record<"home" | "tracker" | "static", string>> = { home: HOME, tracker: TRACKER, static: STATIC };

/** Which kind of critical CSS a page in the build gets, by its path. */
export function pageKind(page: string): PageKind {
    if (page === "index.html") return "home";
    if (page === "play/index.html") return "play";
    // "lol/next-patch/index.html" — a tracker is a game and a topic; about/privacy are one segment.
    return page.split("/").length === 3 ? "tracker" : "static";
}
