/**
 * The header every page shares, written once.
 *
 * Before this there was no shared chrome at all. The homepage carried a `.topbar` with a wordmark and
 * two badges; the other sixteen pages carried a breadcrumb and nothing else. So a visitor who landed on
 * a tracker page from a search result had no way to reach any other part of the site except the
 * footer — and no way to learn the arcade existed at all, because the only real link to it was one card
 * on a page they had never seen.
 *
 * One function builds it and one applier writes it into every page, so the header cannot drift between
 * page kinds the way the critical CSS did before `tokens.ts`.
 *
 * What it deliberately does NOT do: repeat the tracker list. Every page but /play/ already ends with a
 * `nav.footer-nav` naming all twelve trackers. A header that repeated them would double this site's
 * internal linking to say nothing new, so the header carries one link to the grid instead — which is
 * also how /play/, a full-screen game with no footer, reaches every tracker in one tap.
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

export interface ChromeOptions {
    /** The nav item this page belongs to, or "none" where it belongs to no section. */
    section: ChromeSection;
    /** The two claims about the site. The homepage only: it is the one page that is a front door. */
    badges?: boolean;
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
    const indent = options.indent ?? "    ";
    const eol = options.eol ?? "\n";
    const pad = (depth: number) => indent + "  ".repeat(depth);

    const home = options.section === "home" ? ' aria-current="page"' : "";
    const lines: string[] = [];
    lines.push(`${indent}<header class="chrome">`);
    lines.push(`${pad(1)}<a class="chrome-brand" href="/"${home}><span class="dot" aria-hidden="true"></span>NextReset</a>`);
    if (options.title) lines.push(`${pad(1)}<h1 class="chrome-title">${escapeHtml(options.title)}</h1>`);
    lines.push(`${pad(1)}<nav class="chrome-nav" aria-label="Site">`);
    for (const item of NAV) {
        lines.push(`${pad(2)}<a href="${item.href}"${currentAttribute(item, options.section)}>${item.label}</a>`);
    }
    lines.push(`${pad(1)}</nav>`);
    if (options.badges) {
        lines.push(`${pad(1)}<div class="trust-badges">`);
        lines.push(`${pad(2)}<span class="trust-badge">Official sources only</span>`);
        lines.push(`${pad(2)}<span class="trust-badge">Honest data</span>`);
        lines.push(`${pad(1)}</div>`);
    }
    // Empty and hidden in the served HTML, and filled by player.js where there is something to say.
    // A crawler, and a visitor who has never played, must be told nothing about a player who does not
    // exist — the same rule the track control follows.
    lines.push(`${pad(1)}<p class="chrome-player" id="${PLAYER_CHIP_ID}" hidden></p>`);
    lines.push(`${indent}</header>`);
    return lines.join(eol);
}
