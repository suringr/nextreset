/**
 * The AdSense site code, defined once.
 *
 * This is the loader Google documents for connecting a site to AdSense: one script tag in the head of
 * every content page. It is not an ad placement. There are no ad units in this repository, and this
 * file must never grow one — whether an ad is drawn, and where, is decided in the AdSense account, not
 * here.
 *
 * The snippet is a literal in five places: this module, the tracker-page template, and the three
 * hand-authored pages. That is the same shape the Analytics tag already has, and it is the reason the
 * constant exists — the tests compare every shipped page against `ADSENSE_LOADER`, so a page that drifts
 * to a different client, an older snippet, or no snippet at all fails the build rather than the review.
 */

/**
 * The publisher's AdSense client.
 *
 * `pub-8986430839492258` is the publisher ID served in ads.txt; the ad client is the same ID prefixed
 * with `ca-`. Both were verified against the live site and this repository's own history before use.
 */
export const ADSENSE_CLIENT = "ca-pub-8986430839492258";

/** Google's current documented site code, verbatim, with our client substituted. */
export const ADSENSE_LOADER =
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}" crossorigin="anonymous"></script>`;

/**
 * How many AdSense loaders a page carries.
 *
 * Counted by the script source rather than by the exact tag, so a second copy still registers even if
 * it is written with different attribute order or a different client. Two loaders on one page is the
 * failure this catches: it double-requests the library and is the usual result of adding the snippet to
 * both a template and the page it generates.
 */
export function adsenseLoaderCount(html: string): number {
    return html.split("pagead2.googlesyndication.com/pagead/js/adsbygoogle.js").length - 1;
}

/**
 * Whether a page carries ad-unit markup.
 *
 * The loader is site code; `<ins class="adsbygoogle">` is a placement. This repository had placements
 * once — two slots, removed — and they are not coming back by accident.
 */
export function hasAdUnitMarkup(html: string): boolean {
    return /<ins\b[^>]*\badsbygoogle\b/i.test(html) || /\(adsbygoogle\s*=/.test(html);
}

/**
 * Which pages carry the loader.
 *
 * Every page a reader is meant to read, and only those. Two are excluded, for two different reasons,
 * and both are decisions rather than oversights.
 *
 * **404.html** — Google's publisher policy does not allow ads on screens "used for alerts, navigation or
 * other behavioral purposes", and a not-found page is exactly that: no publisher content, just a
 * signpost back to the site. Excluding it costs nothing, since nobody monetises an error page.
 *
 * **play/index.html** — the arcade is an interactive surface where a mis-tap costs a contract. Auto ads
 * place anchors and vignettes over the viewport at the account's discretion, and this repository can
 * neither see nor control that setting; the only way to be certain nothing lands over the game, beside
 * the FIRE button, or across a contract transition is for the page not to carry the library at all.
 * Ads outside the gameplay area may be worth revisiting later, and that is an account-side decision
 * taken deliberately, not something to arrive at by default because a new page inherited the rule.
 *
 * `page` is the path relative to the site root, as the renderer names it: "index.html",
 * "lol/next-patch/index.html", "404.html", "play/index.html".
 */
const WITHOUT_LOADER = new Set(["404.html", "play/index.html"]);

export function carriesLoader(page: string): boolean {
    return !WITHOUT_LOADER.has(page);
}
