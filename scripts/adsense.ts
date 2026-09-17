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
 * Every page a reader is meant to read, and only those. The 404 page is excluded deliberately: Google's
 * publisher policy does not allow ads on screens "used for alerts, navigation or other behavioral
 * purposes", and a not-found page is exactly that — no publisher content, just a signpost back to the
 * site. Excluding it costs nothing (nobody monetises an error page) and keeps the site clear of the one
 * policy family it is currently trying to get out of.
 *
 * `page` is the path relative to the site root, as the renderer names it: "index.html",
 * "lol/next-patch/index.html", "404.html".
 */
export function carriesLoader(page: string): boolean {
    return page !== "404.html";
}
