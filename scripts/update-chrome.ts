/**
 * Write the shared header, and the script that fills it, into every page.
 *
 *   npm run chrome:apply
 *
 * The same shape as `update-design.ts`: one generated region per page, located structurally rather
 * than by matching the markup that happens to be there today, and idempotent — running it twice
 * produces the same file, so it can run after any of the page generators without them knowing about it.
 *
 * The header sits immediately before the page's `.container`, not inside it: it is the approved demo's
 * full-width bar, and a bar inside a centred column cannot reach the edges of the window. A header this
 * applier finds inside the container — where it lived before the demo was ported — is moved out.
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

/** The one element in a page that everything visible sits inside, where the page has one. */
function containerOf(html: string, page: string): ElementMatch | undefined {
    const found = findElements(html, (name, attributes) => name === "div" && hasClass(attributes, "container"));
    if (found.length > 1) {
        throw new Error(`${page}: expected at most one <div class="container">, found ${found.length}`);
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

/** Removes an element together with the line it stands on, and one blank line after it if there is one. */
function removeLines(html: string, element: ElementMatch, eol: string): string {
    const lineStart = html.lastIndexOf("\n", element.start - 1) + 1;
    let end = element.end;
    if (html.startsWith(eol, end)) end += eol.length;
    if (html.startsWith(eol, end)) end += eol.length;
    return html.slice(0, lineStart) + html.slice(end);
}

/**
 * Puts the shared header into one page.
 *
 * A page with a `.container` gets the header as that container's previous sibling, replacing one already
 * there, and taking the place of one found inside it. A page without one — /play/, whose header is the
 * bar above the game — has its header replaced where it stands.
 */
export function applyChrome(html: string, page: string): string {
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const section = sectionOf(page);
    const title = chromeTitleOf(page);

    const existing = chromeOf(html) ?? topbarOf(html);
    const container = containerOf(html, page);

    if (!container) {
        if (!existing) throw new Error(`${page}: no <div class="container"> and no header to replace`);
        // The document has already indented the line this element opens on, so the replacement supplies
        // indentation only for the lines it adds — which is what dropping the first line's copy does.
        const indent = existing.indent || "  ";
        const header = chromeHtml({ section, title, indent, eol });
        return spliceElement(html, existing, header.slice(indent.length));
    }

    if (existing && existing.end <= container.start) {
        const indent = existing.indent || container.indent || "  ";
        const header = chromeHtml({ section, title, indent, eol });
        return spliceElement(html, existing, header.slice(indent.length));
    }

    // Either there is no header yet, or it is still inside the container from before the demo: take it
    // out, then write the header in front of the container.
    const without = existing ? removeLines(html, existing, eol) : html;
    const target = containerOf(without, page)!;
    const indent = target.indent || "  ";
    const header = chromeHtml({ section, title, indent, eol });
    return without.slice(0, target.start) + header.slice(indent.length) + eol + eol + indent + without.slice(target.start);
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
