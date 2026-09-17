/**
 * Write the design tokens into the two places a browser reads them.
 *
 * The palette existed twice: once in `styles.v2.css`, and once in an inline critical-CSS block
 * maintained by hand in fifteen pages. They had already drifted — the pages carried `#0b0f14` and
 * `#111827` while the stylesheet had moved on — and the inline copy wins, because it is what paints
 * first. Every page therefore flashed one palette and settled into another.
 *
 * Both are generated from scripts/design/tokens.ts now:
 *
 *   npm run design:apply
 *
 * and design-tokens.test.ts fails the build if either drifts from the source again.
 *
 * Only the two generated regions are touched. The `:root` block in the stylesheet is bounded by
 * markers; the inline block is the page's first `<style>` element inside its head, found structurally
 * rather than by matching the CSS that happens to be in it today.
 */
import * as fs from "fs";
import * as path from "path";
import { findByTag, findElements } from "./html-elements";
import { PageKind, TOKEN, criticalCss, pageKind, rootBlock } from "./design/tokens";

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const STYLESHEET = path.join(PUBLIC, "assets", "styles.v2.css");

export const TOKENS_START = "/* === GENERATED TOKENS: START === */";
export const TOKENS_END = "/* === GENERATED TOKENS: END === */";

/** Replaces the generated token region of the stylesheet, leaving every authored rule alone. */
export function applyTokensToStylesheet(css: string): string {
    const start = css.indexOf(TOKENS_START);
    const end = css.indexOf(TOKENS_END);
    if (start < 0 || end < 0 || end < start) {
        throw new Error("styles.v2.css: the generated token markers are missing or out of order");
    }
    const eol = css.includes("\r\n") ? "\r\n" : "\n";
    const block = rootBlock().split("\n").join(eol);
    return css.slice(0, start) + TOKENS_START + eol + block + eol + css.slice(end);
}

/**
 * The page's own critical CSS: the first `<style>` in its head.
 *
 * The homepage has a second one inside `<noscript>`, which is not first paint and not this function's
 * business, so the search stops at `</head>`.
 */
export function criticalStyleOf(html: string, page: string) {
    const headEnd = html.toLowerCase().indexOf("</head>");
    if (headEnd < 0) throw new Error(`${page}: no </head>`);
    const inHead = findByTag(html, "style").filter(element => element.start < headEnd);
    if (inHead.length !== 1) {
        throw new Error(`${page}: expected exactly one <style> in the head, found ${inHead.length}`);
    }
    return inHead[0];
}

/** Rewrites one page's inline critical CSS for its kind. */
export function applyCriticalCss(html: string, kind: PageKind, page: string): string {
    const element = criticalStyleOf(html, page);
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const indent = element.indent || "  ";
    // Written over three lines so a diff of the page shows one changed line rather than one changed file.
    const body = `${eol}${indent}  ${criticalCss(kind)}${eol}${indent}`;
    return html.slice(0, element.start) + `<style>${body}</style>` + html.slice(element.end);
}

/**
 * The browser-chrome colour, which is the page ground by another name.
 *
 * Every page declared `#0b0f14` — the previous ground — so a phone drew its address bar in the old
 * palette around the new one. It is the same fact as `--ground`, so it comes from the same place.
 */
export function applyThemeColor(html: string, page: string): string {
    const metas = findElements(html, (name, attributes) => name === "meta" && attributes.name === "theme-color");
    if (metas.length !== 1) throw new Error(`${page}: expected exactly one theme-color meta, found ${metas.length}`);
    const meta = metas[0];
    const replacement = meta.openTag.replace(/content\s*=\s*"[^"]*"/i, `content="${TOKEN["--ground"]}"`);
    return html.slice(0, meta.start) + replacement + html.slice(meta.end);
}

/** The installed-app colours, which are the same two facts again. */
export function applyManifest(json: string): string {
    const manifest = JSON.parse(json) as Record<string, unknown>;
    manifest.theme_color = TOKEN["--ground"];
    manifest.background_color = TOKEN["--ground"];
    return JSON.stringify(manifest, null, 4);
}

/** Every authored HTML page, as a path relative to public/. */
export function authoredPages(): string[] {
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(path.relative(PUBLIC, full).replace(/\\/g, "/"));
        }
    };
    walk(PUBLIC);
    return pages.sort();
}

if (require.main === module) {
    const css = fs.readFileSync(STYLESHEET, "utf8");
    const updated = applyTokensToStylesheet(css);
    if (updated !== css) {
        fs.writeFileSync(STYLESHEET, updated, "utf8");
        console.log("  ✓ assets/styles.v2.css — token block");
    } else {
        console.log("  · assets/styles.v2.css — token block already current");
    }

    let changed = 0;
    for (const page of authoredPages()) {
        const file = path.join(PUBLIC, page);
        const html = fs.readFileSync(file, "utf8");
        const kind = pageKind(page);
        const out = applyThemeColor(applyCriticalCss(html, kind, page), page);
        if (out !== html) {
            fs.writeFileSync(file, out, "utf8");
            changed++;
            console.log(`  ✓ ${page} — critical CSS (${kind})`);
        }
    }
    const manifestFile = path.join(PUBLIC, "site.webmanifest");
    const manifest = fs.readFileSync(manifestFile, "utf8");
    const nextManifest = applyManifest(manifest);
    if (nextManifest !== manifest) {
        fs.writeFileSync(manifestFile, nextManifest, "utf8");
        console.log("  ✓ site.webmanifest — theme and background colour");
    }

    console.log(`✅ Design tokens applied: ${changed} page(s) updated.`);
}
