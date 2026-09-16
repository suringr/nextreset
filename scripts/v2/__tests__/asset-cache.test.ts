/**
 * Assets are cached for a year, so their URLs must change when they do.
 *
 * `public/_headers` marks /assets/*.js and /assets/styles*.css `immutable` with a year's max-age. The
 * pages referenced them at a fixed path, so a returning visitor ran whatever script they first
 * downloaded: fresh HTML (it is `no-cache`) rendered by a year-old app.js. Every client-side correction
 * — keeping a rendered value when a refresh fails, never counting down to an unannounced midnight —
 * was waiting on a cache expiry. These tests hold the two halves together.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assetVersion, versionAssets, versionAssetsInHtml } from "../../version-assets";

const ROOT = path.join(__dirname, "..", "..", "..");

test("a version changes when the file does, and only then", () => {
    assert.equal(assetVersion("console.log(1)"), assetVersion("console.log(1)"));
    assert.notEqual(assetVersion("console.log(1)"), assetVersion("console.log(2)"));
    assert.match(assetVersion("console.log(1)"), /^[0-9a-f]{8}$/);
});

test("every asset a page asks for is stamped, and nothing else is touched", () => {
    const html = [
        `<link rel="stylesheet" href="/assets/styles.v2.css">`,
        `<script src="/assets/app.js" defer></script>`,
        `<img src="/og.png">`,
        `<a href="https://example.test/assets/app.js">elsewhere</a>`,
        `<script src="/assets/missing.js"></script>`
    ].join("\n");
    const versions: Record<string, string> = { "/assets/styles.v2.css": "aaaaaaaa", "/assets/app.js": "bbbbbbbb" };
    const result = versionAssetsInHtml(html, asset => versions[asset]);

    assert.ok(result.html.includes(`href="/assets/styles.v2.css?v=aaaaaaaa"`));
    assert.ok(result.html.includes(`src="/assets/app.js?v=bbbbbbbb" defer`));
    assert.ok(result.html.includes(`<img src="/og.png">`), "an asset outside /assets/ is left alone");
    assert.ok(result.html.includes(`href="https://example.test/assets/app.js"`), "and so is another origin's URL");
    assert.deepEqual(result.missing, ["/assets/missing.js"], "a file the build does not have is reported, not rewritten");

    // Running the build twice must not produce app.js?v=x?v=x.
    const again = versionAssetsInHtml(result.html, asset => versions[asset]);
    assert.equal(again.html, result.html);
});

test("pages in a build are stamped with the version of the file they will actually load", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-assets-"));
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.mkdirSync(path.join(dist, "about"), { recursive: true });
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('v1')");
    const page = `<script src="/assets/app.js"></script>`;
    fs.writeFileSync(path.join(dist, "index.html"), page);
    fs.writeFileSync(path.join(dist, "about", "index.html"), page);

    const first = versionAssets(dist, [path.join(dist, "index.html"), path.join(dist, "about", "index.html")]);
    assert.equal(first.pages, 2);
    const stamped = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    assert.ok(stamped.includes(`?v=${assetVersion("console.log('v1')")}`));
    assert.equal(stamped, fs.readFileSync(path.join(dist, "about", "index.html"), "utf8"), "every page names the same version");

    // The script changes: the next build stamps a different URL, so a year-old copy is not reused.
    fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('v2')");
    fs.writeFileSync(path.join(dist, "index.html"), page);
    const second = versionAssets(dist, [path.join(dist, "index.html")]);
    assert.notDeepEqual(second.versions, first.versions);

    fs.rmSync(dist, { recursive: true, force: true });
});

test("nothing the site serves immutably is published at an unversioned URL", () => {
    const headers = fs.readFileSync(path.join(ROOT, "public", "_headers"), "utf8");
    assert.ok(headers.includes("immutable"), "this test exists because of that header");

    // Which paths the header covers, as globs: /assets/*.js, /assets/styles*.css.
    const immutable = [...headers.matchAll(/^(\/\S+)\r?\n\s+Cache-Control:[^\n]*immutable/gm)].map(m => m[1]);
    assert.ok(immutable.length >= 2, `expected the immutable rules, found ${immutable.join(", ")}`);
    const matches = (asset: string) => immutable.some(rule => new RegExp(`^${rule.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`).test(asset));

    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(full);
        }
    };
    walk(path.join(ROOT, "public"));

    // Every immutable asset an authored page references must exist, so the build can version it. A
    // reference the build cannot resolve would stay unversioned and be cached for a year.
    const referenced = new Set<string>();
    for (const page of pages) {
        for (const match of fs.readFileSync(page, "utf8").matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) referenced.add(match[1]);
    }
    assert.ok(referenced.size > 0, "the pages do reference assets");
    for (const asset of referenced) {
        if (!matches(asset)) continue;
        assert.ok(fs.existsSync(path.join(ROOT, "public", asset.replace(/^\//, ""))), `${asset} is cached for a year but is not in the build`);
    }
});
