/**
 * Writes each tracker's copy from `gamePages` into its authored page: `npm run copy:apply`.
 *
 * `gamePages` (update-game-pages.ts) has always been called the source of truth for per-game copy, but
 * nothing held the pages to it, and they drifted both ways: PR #67 and #73 corrected the pages and the
 * source separately, and six pages no longer matched by the time anyone compared them. A claim corrected
 * in one place and not the other comes back the next time somebody copies from the wrong one.
 *
 * This writes the fields it owns — the meta and Open Graph descriptions, the About paragraph, the What Is
 * paragraph, the What Changes list, and the FAQ in both its visible and its JSON-LD form — and nothing
 * else. It does not regenerate the page (`generatePage` is stale; see update-game-pages.ts). Each field is
 * found by the markup around it, and a field that cannot be found throws rather than being skipped: a page
 * this cannot read is a page whose copy nobody is checking.
 *
 * tracker-copy.test.ts runs it over every authored page and requires the result to equal the page, so the
 * two cannot drift again: change `gamePages`, run this, commit both.
 */
import * as fs from "fs";
import * as path from "path";
import { GamePage, gamePages } from "./update-game-pages";

const text = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attribute = (value: string) => text(value).replace(/"/g, "&quot;");

function replaceOnce(html: string, pattern: RegExp, replace: (match: RegExpExecArray) => string, what: string, page: string): string {
    const all = [...html.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"))];
    if (all.length !== 1) throw new Error(`${page}: expected exactly one ${what}, found ${all.length}`);
    const match = pattern.exec(html)!;
    return html.slice(0, match.index) + replace(match) + html.slice(match.index + match[0].length);
}

function faqSchema(page: GamePage): string {
    const schema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: page.faq.map(item => ({ "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } }))
    };
    return JSON.stringify(schema, null, 2).split("\n").map(line => `    ${line}`).join("\n");
}

/** The page with its copy written from `page`. Pure; line endings are kept as the page has them. */
export function applyCopy(html: string, page: GamePage): string {
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    let out = html.replace(/\r\n/g, "\n");
    const label = page.path;

    out = replaceOnce(out, /<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${attribute(page.metaDescription)}">`, "meta description", label);
    out = replaceOnce(out, /<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${attribute(page.metaDescription)}">`, "og:description", label);

    out = replaceOnce(out, /(<!-- About -->\s*<div class="content-section">\s*<h2>About this tracker<\/h2>\s*<p>)[\s\S]*?(<\/p>)/,
        m => `${m[1]}${text(page.aboutTracker)}${m[2]}`, "About paragraph", label);
    out = replaceOnce(out, /(<!-- What Is It -->\s*<div class="content-section">\s*<h2>[^<]*<\/h2>\s*<p>)[\s\S]*?(<\/p>)/,
        m => `${m[1]}${text(page.whatIsIt)}${m[2]}`, "What Is paragraph", label);

    const changes = /\n[ \t]*<!-- What Changes -->\s*<div class="content-section">\s*<h2>What Changes<\/h2>\s*<ul>[\s\S]*?<\/ul>\s*<\/div>\n/;
    if (page.whatChanges.length === 0) {
        // No list worth keeping: the section goes rather than standing empty.
        if (changes.test(out)) out = replaceOnce(out, changes, () => "\n", "What Changes section", label);
    } else {
        out = replaceOnce(out, /(<!-- What Changes -->\s*<div class="content-section">\s*<h2>What Changes<\/h2>\s*<ul>)[\s\S]*?(\n[ \t]*<\/ul>)/,
            m => `${m[1]}${page.whatChanges.map(item => `\n              <li>${text(item)}</li>`).join("")}${m[2]}`, "What Changes list", label);
    }

    out = replaceOnce(out, /(<!-- FAQ -->\s*<div class="content-section">\s*<h2>Frequently Asked Questions<\/h2>)[\s\S]*?(\n[ \t]*<\/div>)/,
        m => `${m[1]}${page.faq.map(item => [
            `\n            <details class="faq-item">`,
            `\n              <summary>${text(item.q)}</summary>`,
            `\n              <p>${text(item.a)}</p>`,
            `\n            </details>`
        ].join("")).join("")}${m[2]}`, "FAQ section", label);
    out = replaceOnce(out, /<script type="application\/ld\+json">\n    \{\n      "@context": "https:\/\/schema\.org",\n      "@type": "FAQPage",[\s\S]*?\n    \}\n    <\/script>/,
        () => `<script type="application/ld+json">\n${faqSchema(page)}\n    </script>`, "FAQPage JSON-LD", label);

    return eol === "\n" ? out : out.replace(/\n/g, "\r\n");
}

export function pageFile(page: GamePage, publicDir = path.join(__dirname, "..", "public")): string {
    return path.join(publicDir, page.path);
}

if (require.main === module) {
    let changed = 0;
    for (const page of gamePages) {
        const file = pageFile(page);
        const before = fs.readFileSync(file, "utf8");
        const after = applyCopy(before, page);
        if (after !== before) {
            fs.writeFileSync(file, after, "utf8");
            changed++;
            console.log(`updated ${page.path}`);
        }
    }
    console.log(changed === 0 ? "copy: every page already matches gamePages" : `copy: ${changed} page(s) updated`);
}
