/**
 * The header every page shares, and the footer row under every page but the game — written once.
 *
 * Before the header there was no shared chrome at all. The homepage carried a `.topbar` with a wordmark
 * and two badges; the other sixteen pages carried a breadcrumb and nothing else. So a visitor who landed
 * on a tracker page from a search result had no way to reach any other part of the site except the
 * footer — and no way to learn the arcade existed at all.
 *
 * Its look is the approved demo's: a full-width sticky bar, the NEXT//RESET wordmark, the links, and the
 * player chip as a pill. It sits outside the page's column, as the demo's does, so the bar can run the
 * full width of the window while its contents keep the column's edges.
 *
 * On a phone the demo hides the links and offers nothing in their place. That is the one deliberate
 * departure from it: the links stay reachable through a small menu button, a native popover that needs
 * no script. Desktop is the demo's, unchanged.
 *
 * What it deliberately does NOT do: repeat the tracker list. Every page but /play/ already ends with a
 * `nav.footer-nav` naming all twelve trackers, so the header carries one link to the grid instead —
 * which is also how /play/, a full-screen game with no footer, reaches every tracker in one tap.
 */
import { PageKind, pageKind } from "./tokens";
import { ONE_SHOT_NAME } from "./one-shot";

/** Which navigation item a page belongs to. */
export type ChromeSection = "home" | "trackers" | "arcade" | "about" | "none";

export interface NavItem {
    section: ChromeSection;
    label: string;
    href: string;
}

/**
 * The navigation, in order.
 *
 * Three items. The wordmark is the way home, so "Home" is not repeated here — a brand that is also a
 * nav item is the same link twice, and the first one is the one everybody already tries.
 */
export const NAV: ReadonlyArray<NavItem> = [
    { section: "trackers", label: "Trackers", href: "/#all-games" },
    { section: "arcade", label: "Arcade", href: "/play/" },
    { section: "about", label: "About", href: "/about/" }
];

/** The id the player chip is found by. Named here because two files have to agree on it. */
export const PLAYER_CHIP_ID = "chrome-player";

/** The id the phone's menu button opens. Named here because the button and the nav have to agree on it. */
export const SITE_NAV_ID = "site-nav";

/** The site's name, which the wordmark draws as NEXT//RESET and a screen reader hears as a word. */
export const SITE_NAME = "NextReset";

export interface ChromeOptions {
    /** The nav item this page belongs to, or "none" where it belongs to no section. */
    section: ChromeSection;
    /** The page's h1, where the header is the only place it can sit. See `chromeTitleOf`. */
    title?: string;
    /** Indentation for the element's own line. */
    indent?: string;
    /** Line ending to emit. */
    eol?: string;
}

/**
 * Which section a page belongs to, from its path.
 *
 * Built on `pageKind` so that a page cannot be a tracker for the critical CSS and something else for
 * the navigation. Privacy and the 404 belong to no section: marking "About" current on the privacy
 * policy would be a claim the link does not support.
 */
export function sectionOf(page: string): ChromeSection {
    const kind: PageKind = pageKind(page);
    if (kind === "home") return "home";
    if (kind === "tracker") return "trackers";
    if (kind === "play") return "arcade";
    return page === "about/index.html" ? "about" : "none";
}

/**
 * The h1 a page carries inside its header, if any.
 *
 * Only /play/. The game fills the screen below the header, as the approved prototype does, so the game's
 * name sits where the prototype put it: beside the wordmark, in the bar. Every other page has its h1 in
 * its own content, and the header stays navigation.
 */
export function chromeTitleOf(page: string): string | undefined {
    return pageKind(page) === "play" ? ONE_SHOT_NAME : undefined;
}

/**
 * How a nav item says it is the page you are on.
 *
 * `page` where the link really does point at this page, and `true` — "the current item in this set" —
 * for a tracker page, which belongs to Trackers without being the URL Trackers points at. Claiming
 * `page` there would tell a screen reader the link leads nowhere new, which is not what is meant.
 */
function currentAttribute(item: NavItem, section: ChromeSection): string {
    if (item.section !== section) return "";
    return item.section === "trackers" ? ' aria-current="true"' : ' aria-current="page"';
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The shared header, as HTML. */
export function chromeHtml(options: ChromeOptions): string {
    const indent = options.indent ?? "  ";
    const eol = options.eol ?? "\n";
    const pad = (depth: number) => indent + "  ".repeat(depth);

    const home = options.section === "home" ? ' aria-current="page"' : "";
    const lines: string[] = [];
    lines.push(`${indent}<header class="chrome top">`);
    lines.push(`${pad(1)}<div class="wrap nav">`);
    lines.push(`${pad(2)}<a class="chrome-brand" href="/" aria-label="${SITE_NAME}"${home}>NEXT<i>//</i>RESET</a>`);
    if (options.title) lines.push(`${pad(2)}<h1 class="chrome-title">${escapeHtml(options.title)}</h1>`);
    lines.push(`${pad(2)}<nav class="chrome-nav" id="${SITE_NAV_ID}" aria-label="Site" popover>`);
    for (const item of NAV) {
        lines.push(`${pad(3)}<a href="${item.href}"${currentAttribute(item, options.section)}>${item.label}</a>`);
    }
    lines.push(`${pad(2)}</nav>`);
    // The chip and the phone's menu button stay together at the right edge: on a narrow phone with a long
    // chip the bar wraps, and the pair moves to the next row as one, rather than the menu alone.
    lines.push(`${pad(2)}<div class="chrome-end">`);
    // Empty and hidden in the served HTML, and filled by player.js where there is something to say.
    // A crawler, and a visitor who has never played, must be told nothing about a player who does not
    // exist — the same rule the track control follows.
    lines.push(`${pad(3)}<p class="chrome-player" id="${PLAYER_CHIP_ID}" hidden></p>`);
    lines.push(`${pad(3)}<button type="button" class="chrome-menu" popovertarget="${SITE_NAV_ID}" aria-label="Menu"><span class="chrome-menu-icon" aria-hidden="true"></span></button>`);
    lines.push(`${pad(2)}</div>`);
    lines.push(`${pad(1)}</div>`);
    lines.push(`${indent}</header>`);
    return lines.join(eol);
}

/**
 * The demo's footer row: the wordmark, the line, and the site's links — the same on every page that has
 * a footer, which is every page but the full-screen game.
 *
 * The two sentences the footer already carried — how often the sources are checked, and that the site is
 * not affiliated with any publisher — stay beneath it: the demo has no place for them, and they are not
 * the kind of thing a redesign gets to drop.
 */
export const FOOTER_ROW = [
    `<div class="footer-row">`,
    `  <b class="footer-mark">NEXT//RESET</b>`,
    `  <span class="footer-line">Know what's next. Play while you wait.</span>`,
    `  <span class="footer-links"><a href="/about/">About</a> · <a href="/privacy/">Privacy Policy</a> · <a href="/play/">Arcade</a> · © 2026</span>`,
    `</div>`,
    `<p class="footer-fine">Checked automatically several times a day against official sources. Not affiliated with any game publishers. All trademarks belong to their respective owners.</p>`
];

/** The footer row, indented for the page it goes into. */
export function footerRowHtml(indent: string, eol = "\n"): string {
    return FOOTER_ROW.map(line => indent + line).join(eol);
}
