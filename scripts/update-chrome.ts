/**
 * Write the shared header, and the script that fills it, into every page.
 *
 *   npm run chrome:apply
 *
 * The same shape as `update-design.ts`: one generated region per page, located structurally rather
 * than by matching the markup that happens to be there today, and idempotent — running it twice
 * produces the same file, so it can run after any of the page generators without them knowing about it.
 *
 * `chrome.test.ts` asserts every built page carries the header this produces, so a generator re-run
 * without this applier fails the build rather than quietly publishing a page with no way out of it.
 */
import * as fs from "fs";
import * as path from "path";
import { ElementMatch, findElements, hasClass, spliceElement } from "./html-elements";
import { chromeHtml, chromeTitleOf, sectionOf } from "./design/chrome";
import { authoredPages } from "./update-design";

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

const PLAYER_SCRIPT = `<script src="/assets/player.js" defer></script>`;

/** The one element in a page that everything visible sits inside. */
function containerOf(html: string, page: string): ElementMatch {
    const found = findElements(html, (name, attributes) => name === "div" && hasClass(attributes, "container"));
    if (found.length !== 1) {
        throw new Error(`${page}: expected exactly one <div class="container">, found ${found.length}`);
    }
    return found[0];
}

/** The header this applier owns, where the page already has one. */
function chromeOf(html: string): ElementMatch | undefined {
    const found = findElements(html, (name, attributes) => name === "header" && hasClass(attributes, "chrome"));
    if (found.length > 1) throw new Error("more than one <header class=\"chrome\">");
    return found[0];
}

/** The homepage's pre-V4 header, which the shared one replaces. */
function topbarOf(html: string): ElementMatch | undefined {
    return findElements(html, (name, attributes) => name === "div" && hasClass(attributes, "topbar"))[0];
}

/**
 * Puts the shared header into one page.
 *
 * Three cases, in order: replace the header this applier wrote last time; replace the homepage's old
 * topbar; otherwise insert it as the container's first child, which is where every page kind has its
 * first visible element.
 */
export function applyChrome(html: string, page: string): string {
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const section = sectionOf(page);
    const badges = page === "index.html";
    const title = chromeTitleOf(page);

    const existing = chromeOf(html) ?? topbarOf(html);
    if (existing) {
        // The document has already indented the line this element opens on, so the replacement supplies
        // indentation only for the lines it adds — which is what dropping the first line's copy does.
        const indent = existing.indent || "    ";
        const header = chromeHtml({ section, badges, title, indent, eol });
        return spliceElement(html, existing, header.slice(indent.length));
    }

    const container = containerOf(html, page);
    const indent = (container.indent || "  ") + "  ";
    const header = chromeHtml({ section, badges, title, indent, eol });
    const openEnd = container.start + container.openTag.length;
    return html.slice(0, openEnd) + eol + header + html.slice(openEnd);
}

/**
 * Makes sure the page loads the player record.
 *
 * The header's chip is the only part of a player that every page shows, and `player.js` is what fills
 * it. Pages that already load it are left alone; pages that load `app.js` get it immediately before,
 * because app.js reads the record; pages with no scripts at all get it just before `</body>`.
 */
export function applyPlayerScript(html: string, page: string): string {
    if (html.includes(`src="/assets/player.js"`)) return html;
    const eol = html.includes("\r\n") ? "\r\n" : "\n";

    const app = html.indexOf(`<script src="/assets/app.js"`);
    if (app >= 0) {
        const lineStart = html.lastIndexOf("\n", app) + 1;
        const indent = html.slice(lineStart, app);
        return html.slice(0, lineStart) + indent + PLAYER_SCRIPT + eol + html.slice(lineStart);
    }

    const body = html.lastIndexOf("</body>");
    if (body < 0) throw new Error(`${page}: no </body>`);
    const lineStart = html.lastIndexOf("\n", body) + 1;
    const indent = html.slice(lineStart, body);
    return html.slice(0, lineStart) + indent + "  " + PLAYER_SCRIPT + eol + html.slice(lineStart);
}

if (require.main === module) {
    let changed = 0;
    for (const page of authoredPages()) {
        const file = path.join(PUBLIC, page);
        const html = fs.readFileSync(file, "utf8");
        const out = applyPlayerScript(applyChrome(html, page), page);
        if (out !== html) {
            fs.writeFileSync(file, out, "utf8");
            changed++;
            console.log(`  ✓ ${page} — header (${sectionOf(page)})`);
        } else {
            console.log(`  · ${page} — header already current`);
        }
    }
    console.log(changed === 0 ? "\nEvery page already carries the header." : `\n${changed} page(s) updated.`);
}
