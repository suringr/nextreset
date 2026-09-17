/**
 * The V4 palette, type scale and geometry — declared once, consumed everywhere.
 *
 * Three things used to be true at the same time, and all three were problems.
 *
 * The brand colour and the "verified" colour were the same green, so the site could not visually
 * separate "this is NextReset" from "this value is verified" — the one distinction the whole product
 * rests on. V4 gives identity to violet and leaves green to mean verified, amber to mean stale and slate
 * to mean unavailable. Those three are the load-bearing colours here and are never spent on decoration.
 *
 * The muted text failed AA. `#6b7280` on `#0b0f14` is 3.98:1, used at 11–13px throughout the info
 * panels and card meta. Every text token below is checked against every surface it can sit on by
 * design-tokens.test.ts, so the palette cannot regress without failing the build.
 *
 * And the colours were written out twice: once in `styles.v2.css` and again in an inline critical-CSS
 * block hand-maintained in fifteen pages, which had already drifted. Both are now generated from here.
 *
 * No webfont: the site's advantage is that it is fast, and a display face is a request on the critical
 * path. The numeric stack gives the HUD its character using fonts the device already has.
 */

/** Every custom property, in the order the `:root` block declares them. */
export const TOKENS: ReadonlyArray<readonly [string, string, string]> = [
    // name, value, why it exists
    ["--ground", "#050812", "the page itself"],
    ["--ground-2", "#0a1020", "the far end of the page gradient"],
    ["--surface", "#0b1325", "a card or panel"],
    ["--surface-2", "#101a31", "a panel raised above another panel"],
    ["--line", "#26395f", "the edge of a surface"],
    ["--line-soft", "#1b2a47", "a divider inside a surface"],

    ["--ink", "#f5f7ff", "anything a reader is meant to read"],
    ["--ink-muted", "#aab7cf", "supporting text: topics, notes, prose"],
    ["--ink-faint", "#93a2be", "labels and meta, down to 11px — the token that used to fail AA"],

    ["--brand", "#8b5cf6", "NextReset, and nothing else"],
    ["--brand-bright", "#b69dff", "the brand as text or a link, where #8b5cf6 is too dark to read"],
    ["--state-verified", "#34d399", "the source confirmed this value"],
    ["--state-stale", "#fbbf24", "the value stands but the source could not be checked"],
    ["--state-unavailable", "#9fb0c9", "there is no verified value, or its date has passed"],

    ["--brand-soft", "rgba(139, 92, 246, .15)", "brand fill behind a pill"],
    ["--brand-line", "rgba(139, 92, 246, .38)", "brand edge"],
    ["--verified-soft", "rgba(52, 211, 153, .14)", "verified fill"],
    ["--verified-line", "rgba(52, 211, 153, .32)", "verified edge"],
    ["--stale-soft", "rgba(251, 191, 36, .14)", "stale fill"],
    ["--stale-line", "rgba(251, 191, 36, .34)", "stale edge"],
    ["--unavailable-soft", "rgba(159, 176, 201, .13)", "unavailable fill"],
    ["--unavailable-line", "rgba(159, 176, 201, .30)", "unavailable edge"],
    ["--sheen", "rgba(255, 255, 255, .035)", "the light on the top edge of a card"],
    ["--scrim", "rgba(3, 6, 17, .72)", "a surface laid over the page"],

    ["--radius", "14px", "a card or panel"],
    ["--radius-sm", "10px", "a row or a small control"],
    ["--radius-pill", "999px", "a badge"],
    ["--shadow", "0 10px 30px rgba(0, 0, 0, .45)", "a surface at rest"],
    ["--shadow-lift", "0 16px 40px rgba(0, 0, 0, .55)", "a surface under the pointer"],

    ["--font", 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', "everything"],
    ["--font-num", 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', "digits that have to line up: countdowns, timestamps"],

    ["--size-display", "clamp(34px, 9vw, 54px)", "the one value a page exists to publish"],
    ["--size-h1", "clamp(27px, 6vw, 40px)", "the page heading"],
    ["--size-h2", "clamp(19px, 3.2vw, 23px)", "a section heading"],
    ["--size-lead", "clamp(15px, 2.2vw, 17px)", "introductory prose"],
    ["--size-body", "15px", "running text"],
    ["--size-small", "13px", "supporting text"],
    ["--size-label", "11px", "an uppercase label"],

    ["--sp-1", "4px", ""],
    ["--sp-2", "8px", ""],
    ["--sp-3", "12px", ""],
    ["--sp-4", "16px", ""],
    ["--sp-5", "24px", ""],
    ["--sp-6", "32px", ""],
    ["--sp-7", "48px", ""],

    ["--gutter", "16px", "the smallest side margin any page keeps, at any width"],
    ["--measure", "68ch", "how wide running text is allowed to get"],
    ["--tap", "44px", "the smallest interactive target, per WCAG 2.5.5"]
];

/** Token name to value, for tests and for anything that needs one colour by name. */
export const TOKEN: Record<string, string> = Object.fromEntries(TOKENS.map(([name, value]) => [name, value]));

/**
 * Which tokens carry text, what they sit on, and how big they get.
 *
 * The pairing is declared rather than inferred, because "is this readable" has no answer without
 * knowing the surface. A token used at 11px has to clear AA for normal text; nothing here is exempted
 * for being large, except the two that only ever set a display-sized value.
 */
export const TEXT_ON_SURFACE: ReadonlyArray<{ ink: string; on: string[]; minimum: number; note: string }> = [
    { ink: "--ink", on: ["--ground", "--surface", "--surface-2"], minimum: 4.5, note: "body and headings" },
    { ink: "--ink-muted", on: ["--ground", "--surface", "--surface-2"], minimum: 4.5, note: "supporting prose at 13–15px" },
    { ink: "--ink-faint", on: ["--ground", "--surface", "--surface-2"], minimum: 4.5, note: "labels at 11px" },
    { ink: "--state-verified", on: ["--ground", "--surface"], minimum: 4.5, note: "badge text and the verified value" },
    { ink: "--state-stale", on: ["--ground", "--surface"], minimum: 4.5, note: "badge text on a stale value" },
    { ink: "--state-unavailable", on: ["--ground", "--surface"], minimum: 4.5, note: "badge text and the unavailable value" },
    { ink: "--brand-bright", on: ["--ground", "--surface", "--surface-2"], minimum: 4.5, note: "links and the brand as text" },
    { ink: "--brand", on: ["--ground", "--surface"], minimum: 3, note: "never text: an edge, a dot, a meter fill" }
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
 * What every page needs before the stylesheet arrives: the tokens, the page ground, the wrapper.
 *
 * `--gutter` as side padding on one element, and `padding-block` for the vertical, so no shorthand can
 * ever zero the side margin — which is how a phone ends up with text against the glass.
 */
const SHARED = [
    `*{box-sizing:border-box}`,
    `body{margin:0;background-color:var(--ground);color:var(--ink);font-family:var(--font);font-size:var(--size-body);line-height:1.55;min-height:100vh;-webkit-text-size-adjust:100%}`,
    `.container{width:100%;max-width:1040px;margin:0 auto;padding-inline:var(--gutter);padding-block:var(--sp-5)}`,
    `a{color:inherit;text-decoration:none}`,
    `h1,h2,h3{line-height:1.15;margin:0;text-wrap:balance}`
].join("");

/** The homepage: brand row, hero, and the card grid, which is what a phone sees first. */
const HOME = [
    `.topbar{display:flex;align-items:center;justify-content:space-between;gap:var(--sp-3);margin-bottom:var(--sp-5)}`,
    `.brand{display:flex;align-items:center;gap:var(--sp-2);font-weight:800;font-size:19px;letter-spacing:-.01em}`,
    `.dot{width:9px;height:9px;border-radius:50%;background:var(--state-verified);flex:none}`,
    `.trust-badges{display:none;gap:var(--sp-2)}`,
    `.trust-badge{font-size:var(--size-label);color:var(--ink-faint);padding:4px 10px;border:1px solid var(--line-soft);border-radius:var(--radius-pill);text-transform:uppercase;letter-spacing:.06em;font-weight:700}`,
    `.section,.shelf-section{margin:0 0 var(--sp-6)}`,
    `.section-heading{font-size:var(--size-label);font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-faint);margin:0 0 var(--sp-3)}`,
    `.drop{background:linear-gradient(180deg,var(--sheen),transparent 55%),var(--surface);border:1px solid var(--brand-line);border-radius:var(--radius);padding:var(--sp-5) var(--sp-4);margin:0 0 var(--sp-6)}`,
    `.drop-eyebrow{font-size:var(--size-label);font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--brand-bright);margin:0 0 var(--sp-2)}`,
    `.drop-game{font-size:var(--size-h1);font-weight:900;letter-spacing:-.02em;margin:0}`,
    `.drop-topic{color:var(--ink-muted);margin:var(--sp-1) 0 var(--sp-4);font-size:var(--size-lead)}`,
    `.drop-value{font-family:var(--font-num);font-size:var(--size-display);font-weight:700;letter-spacing:-.03em;line-height:1.05;color:var(--state-verified);font-variant-numeric:tabular-nums;overflow-wrap:break-word}`,
    `.drop-value.is-date{font-family:var(--font);font-size:clamp(26px,6.5vw,40px);font-weight:800;letter-spacing:-.02em}`,
    `.drop-precision{color:var(--ink-faint);font-size:var(--size-small);font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin:var(--sp-2) 0 0}`,
    `.drop-trust{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2) var(--sp-3);margin:var(--sp-4) 0 0;color:var(--ink-faint);font-size:12px}`,
    `.drop-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2);margin:var(--sp-5) 0 0}`,
    `.btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-2);min-height:var(--tap);padding:0 var(--sp-4);border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--ink);font:inherit;font-weight:700;cursor:pointer;text-align:center;flex:1 1 auto}`,
    `.btn-primary{border-color:transparent;background:var(--brand)}`,
    `.card-slot{position:relative;display:flex}`,
    `.hero{margin:0 0 var(--sp-5)}`,
    `.h1{font-size:var(--size-lead);font-weight:800;letter-spacing:-.01em;margin:0 0 var(--sp-1)}`,
    `.sub{color:var(--ink-muted);margin:0;font-size:var(--size-lead);max-width:var(--measure)}`,
    `.grid{display:grid;gap:var(--sp-3);grid-template-columns:1fr;margin-top:var(--sp-4)}`,
    `.group-heading{grid-column:1/-1;font-size:var(--size-label);font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-faint);margin:var(--sp-4) 0 0}`,
    `.group-heading:first-child{margin-top:0}`,
    `.card{flex:1 1 auto;display:block;background:linear-gradient(180deg,var(--sheen),transparent 60%),var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp-4);min-height:132px}`,
    `.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:var(--sp-2);margin-bottom:var(--sp-3)}`,
    `.card-title{font-size:17px;font-weight:800;margin:0}`,
    `.card-topic{color:var(--ink-faint);font-size:var(--size-label);text-transform:uppercase;letter-spacing:.12em;font-weight:700;margin-bottom:var(--sp-2)}`,
    `.card-countdown{font-family:var(--font-num);font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em;margin-bottom:var(--sp-3)}`,
    `.card-countdown.is-text{font-family:var(--font);font-size:18px;font-weight:800;line-height:1.3}`,
    `.card-meta{display:flex;gap:var(--sp-3);flex-wrap:wrap;color:var(--ink-faint);font-size:12px}`,
    `.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:var(--radius-pill);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}`,
    `.badge-live{background:var(--verified-soft);color:var(--state-verified);border:1px solid var(--verified-line)}`,
    `.badge-stale{background:var(--stale-soft);color:var(--state-stale);border:1px solid var(--stale-line)}`,
    `.badge-unavailable{background:var(--unavailable-soft);color:var(--state-unavailable);border:1px solid var(--unavailable-line)}`,
    `@media(min-width:768px){.grid{grid-template-columns:repeat(2,1fr)}.trust-badges{display:flex}.h1{font-size:var(--size-h1)}}`,
    `@media(min-width:1080px){.grid{grid-template-columns:repeat(3,1fr)}}`
].join("");

/** A tracker page: the answer, and the panel that says where it came from. */
const TRACKER = [
    `.game-page{max-width:var(--measure);margin:0 auto}`,
    `.breadcrumbs{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);color:var(--ink-faint);font-size:var(--size-small);font-weight:600;margin-bottom:var(--sp-5)}`,
    `.breadcrumbs a,.breadcrumbs [aria-current="page"]{display:inline-flex;align-items:center;min-height:var(--tap)}`,
    `.game-header{margin-bottom:var(--sp-5)}`,
    `.game-title{font-size:var(--size-h1);font-weight:900;letter-spacing:-.02em;margin:0 0 var(--sp-3)}`,
    `.game-meta{display:flex;gap:var(--sp-3);flex-wrap:wrap;color:var(--ink-faint);font-size:var(--size-small)}`,
    `.kicker{font-size:var(--size-label);letter-spacing:.14em;text-transform:uppercase;font-weight:800}`,
    `.countdown-box{background:linear-gradient(180deg,var(--sheen),transparent 70%),var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp-6) var(--sp-4);text-align:center;margin:var(--sp-6) 0}`,
    `.countdown-label{color:var(--ink-faint);font-size:var(--size-label);letter-spacing:.14em;text-transform:uppercase;font-weight:800;margin-bottom:var(--sp-4)}`,
    `.countdown-value{font-family:var(--font-num);font-size:var(--size-display);font-weight:700;letter-spacing:-.03em;color:var(--state-verified);font-variant-numeric:tabular-nums;line-height:1.08;overflow-wrap:break-word}`,
    `.countdown-value.unavailable{font-family:var(--font);font-size:clamp(21px,5vw,30px);font-weight:800;color:var(--state-unavailable);letter-spacing:-.01em;line-height:1.2}`,
    `.countdown-value.stale{color:var(--state-stale)}`,
    `.info-panel{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp-3) var(--sp-4);margin:var(--sp-5) 0}`,
    `.info-row{display:flex;justify-content:space-between;align-items:baseline;gap:var(--sp-4);padding:var(--sp-3) 0;border-bottom:1px solid var(--line-soft)}`,
    `.info-row:last-child{border-bottom:none}`,
    `.info-label{color:var(--ink-faint);font-size:var(--size-label);text-transform:uppercase;letter-spacing:.1em;font-weight:700;flex:none}`,
    `.info-value{font-weight:700;color:var(--ink);text-align:right;overflow-wrap:anywhere}`,
    `.content-section{margin:var(--sp-6) 0}`,
    `.content-section h2{font-size:var(--size-h2);font-weight:800;margin:0 0 var(--sp-3)}`,
    `.content-section p{color:var(--ink-muted);margin:0 0 var(--sp-4)}`,
    `@media(min-width:768px){.countdown-box{padding:var(--sp-7) var(--sp-6)}}`
].join("");

/**
 * The arcade. Only what decides the board's size and the controls' reach.
 *
 * Sized by height as well as width, because on a phone in portrait the limit is vertical: the HUD, the
 * board and the control bar all have to be on screen at once without the page scrolling during a run.
 */
const PLAY = [
    `.page{max-width:var(--measure);margin:0 auto}`,
    `.breadcrumbs{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);color:var(--ink-faint);font-size:var(--size-small);font-weight:600;margin-bottom:var(--sp-5)}`,
    `.breadcrumbs a,.breadcrumbs [aria-current="page"]{display:inline-flex;align-items:center;min-height:var(--tap)}`,
    `.game-header{margin-bottom:var(--sp-3)}`,
    `.game-title{font-size:var(--size-h1);font-weight:900;letter-spacing:-.02em;margin:0 0 var(--sp-2)}`,
    `.game-meta{display:flex;gap:var(--sp-3);color:var(--ink-faint);font-size:var(--size-small)}`,
    `.kicker{color:var(--ink-faint);font-size:var(--size-label);letter-spacing:.14em;text-transform:uppercase;font-weight:800}`,
    `.sub{color:var(--ink-muted);margin:0 0 var(--sp-5);font-size:var(--size-lead);max-width:var(--measure)}`,
    `.play{margin:0 0 var(--sp-6)}`,
    `.stage{position:relative;width:100%;max-width:min(100%,calc((100dvh - 260px) * 0.8));aspect-ratio:4 / 5;margin:0 auto;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--ground)}`,
    `#board{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}`,
    `.hud{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--sp-1);margin-bottom:var(--sp-2)}`,
    `.hud-cell{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);padding:var(--sp-2)}`,
    `.hud-cell small{display:block;color:var(--ink-faint);font-size:9px;letter-spacing:.1em;text-transform:uppercase;font-weight:700}`,
    `.hud-cell b{font-family:var(--font-num);font-size:14px;font-variant-numeric:tabular-nums}`,
    `.controls{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--sp-2);margin-top:var(--sp-2)}`,
    `.control{min-height:var(--tap);border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--ink);font:inherit;font-weight:800;letter-spacing:.06em;cursor:pointer}`,
    `.meter{height:6px;background:var(--surface-2);border-radius:var(--radius-pill);overflow:hidden;margin-top:var(--sp-2)}`,
    `.meter i{display:block;height:100%;width:0;background:var(--brand)}`,
    `.overlay{position:absolute;inset:0;display:grid;place-items:center;padding:var(--sp-4);background:var(--scrim);text-align:center}`,
    `.overlay[hidden]{display:none}`,
    `.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}`,
    `@media(min-width:560px){.hud{grid-template-columns:repeat(7,1fr)}.controls{grid-template-columns:repeat(4,1fr)}}`
].join("");

/** About, Privacy, 404: prose and a way back. */
const STATIC = [
    `.page{max-width:var(--measure);margin:0 auto}`,
    `.breadcrumbs{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2);color:var(--ink-faint);font-size:var(--size-small);font-weight:600;margin-bottom:var(--sp-5)}`,
    `.breadcrumbs a,.breadcrumbs [aria-current="page"]{display:inline-flex;align-items:center;min-height:var(--tap)}`,
    `h1{font-size:var(--size-h1);font-weight:900;letter-spacing:-.02em;margin:0 0 var(--sp-4)}`,
    `h2{font-size:var(--size-h2);font-weight:800;margin:var(--sp-6) 0 var(--sp-3)}`,
    `p{color:var(--ink-muted);margin:0 0 var(--sp-4)}`,
    `a{color:var(--brand-bright)}`
].join("");

/**
 * The inline block a page ships for its first paint.
 *
 * Generated rather than authored, because the same rules were being maintained by hand in fifteen
 * files. `design-tokens.test.ts` asserts every page carries exactly what this function returns for it.
 */
export function criticalCss(kind: PageKind): string {
    const body = kind === "home" ? HOME : kind === "tracker" ? TRACKER : kind === "play" ? PLAY : STATIC;
    return rootBlockCompact() + SHARED + body;
}

/** Which kind of critical CSS a page in the build gets, by its path. */
export function pageKind(page: string): PageKind {
    if (page === "index.html") return "home";
    if (page === "play/index.html") return "play";
    // "lol/next-patch/index.html" — a tracker is a game and a topic; about/privacy are one segment.
    return page.split("/").length === 3 ? "tracker" : "static";
}
