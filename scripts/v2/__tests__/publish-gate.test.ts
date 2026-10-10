/**
 * The publish gate: what must be true of dist/ before it replaces the live site.
 *
 * The deploy force-pushes an orphan commit over `gh-pages`, so a bad build does not sit next to the good
 * one — it replaces it. And the publish job runs `build:site` without `npm test`, so this gate is the
 * only thing between a broken render and production. These tests exist to make sure it actually refuses,
 * rather than printing a tick next to anything handed to it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { inspect, sitemapPaths } from "../../publish-gate";
import { pagePaths, trackerPages } from "../../site-map";

const NOINDEX = `<meta name="robots" content="noindex, follow">`;

/**
 * A minimal build that the gate should accept: every declared page present, trackers indexable, and a
 * sitemap listing exactly the indexable ones.
 */
function healthyBuild(): { dir: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-gate-"));
    const indexable: string[] = [];
    for (const page of pagePaths()) {
        const file = path.join(dir, page);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 404 and the arcade ask not to be indexed; everything else answers.
        const withheld = page === "404.html" || page === "play/index.html";
        fs.writeFileSync(file, `<!DOCTYPE html><html><head>${withheld ? NOINDEX : ""}</head><body><h1>${page}</h1>`
            + `<div class="countdown-value" data-nr-slot="answer-value">October 21, 2026</div></body></html>`, "utf8");
        if (!withheld) indexable.push(page);
    }
    writeSitemap(dir, indexable);
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeSitemap(dir: string, pages: string[]): void {
    const urls = pages
        .map(page => "/" + page.replace(/index\.html$/, ""))
        .map(location => `  <url><loc>https://nextreset.co${location}</loc></url>`)
        .join("\n");
    fs.writeFileSync(path.join(dir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${urls}\n</urlset>\n`, "utf8");
}

const refusals = (dir: string) => inspect(dir).findings.filter(finding => finding.level === "refuse").map(finding => finding.message);

test("a healthy build passes", () => {
    const build = healthyBuild();
    try {
        assert.deepEqual(refusals(build.dir), [], "the gate refused a build that is fine");
    } finally {
        build.cleanup();
    }
});

test("a build where no tracker answers is refused", () => {
    // The systemic-failure case: no network, an empty store, a renderer that threw. Publishing it
    // replaces every answer on the site with "Data unavailable", and the force-push makes that
    // irreversible.
    const build = healthyBuild();
    try {
        for (const entry of trackerPages()) {
            const file = path.join(build.dir, entry.page);
            fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("<head>", `<head>${NOINDEX}`), "utf8");
        }
        writeSitemap(build.dir, pagePaths().filter(page =>
            page !== "404.html" && page !== "play/index.html" && !trackerPages().some(entry => entry.page === page)));
        assert.match(refusals(build.dir).join("\n"), /none of the \d+ trackers is indexable/);
    } finally {
        build.cleanup();
    }
});

test("one tracker still answering is enough to publish", () => {
    // The ordinary bad day, which must still ship: eleven providers down, one up. The site is thinner
    // than usual and completely honest about it, and that is worth publishing.
    const build = healthyBuild();
    try {
        const [, ...rest] = trackerPages();
        for (const entry of rest) {
            const file = path.join(build.dir, entry.page);
            fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("<head>", `<head>${NOINDEX}`), "utf8");
        }
        writeSitemap(build.dir, pagePaths().filter(page =>
            page !== "404.html" && page !== "play/index.html" && !rest.some(entry => entry.page === page)));
        assert.deepEqual(refusals(build.dir), [], "a thin but honest build should still publish");
    } finally {
        build.cleanup();
    }
});

test("a placeholder where a value should be is refused", () => {
    // In the slot the renderer writes into — which is where an unrendered page leaves its placeholder,
    // and the only place the gate looks.
    const build = healthyBuild();
    try {
        const page = trackerPages()[0].page;
        const file = path.join(build.dir, page);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("October 21, 2026", "--:--:--"), "utf8");
        assert.match(refusals(build.dir).join(" | "), /still shows "--:--"/);
    } finally {
        build.cleanup();
    }
});

test("a page that asks not to be indexed may not be in the sitemap", () => {
    const build = healthyBuild();
    try {
        const page = trackerPages()[0].page;
        const file = path.join(build.dir, page);
        fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("<head>", `<head>${NOINDEX}`), "utf8");
        // The sitemap still lists it, which is the contradiction.
        assert.match(refusals(build.dir).join("\n"), /is in the sitemap and asks not to be indexed/);
    } finally {
        build.cleanup();
    }
});

test("a sitemap entry that was never built is refused", () => {
    const build = healthyBuild();
    try {
        const xml = fs.readFileSync(path.join(build.dir, "sitemap.xml"), "utf8")
            .replace("</urlset>", "  <url><loc>https://nextreset.co/ghost/</loc></url>\n</urlset>");
        fs.writeFileSync(path.join(build.dir, "sitemap.xml"), xml, "utf8");
        assert.match(refusals(build.dir).join("\n"), /\/ghost\/ is in the sitemap but was not built/);
    } finally {
        build.cleanup();
    }
});

test("a declared page the build did not produce is refused", () => {
    // A 404 on a URL that was in yesterday's sitemap is the worst kind of regression: silent, and only
    // visible to the crawler.
    const build = healthyBuild();
    try {
        fs.rmSync(path.join(build.dir, trackerPages()[0].page));
        assert.match(refusals(build.dir).join("\n"), /missing 1 declared page/);
    } finally {
        build.cleanup();
    }
});

test("a build with no sitemap at all is refused", () => {
    const build = healthyBuild();
    try {
        fs.rmSync(path.join(build.dir, "sitemap.xml"));
        assert.match(refusals(build.dir).join("\n"), /no sitemap\.xml/);
    } finally {
        build.cleanup();
    }
});

test("sitemap locations are read as paths, whatever the origin", () => {
    const xml = `<urlset>
  <url><loc>https://nextreset.co/</loc></url>
  <url><loc>  https://nextreset.co/lol/next-patch/  </loc></url>
</urlset>`;
    assert.deepEqual(sitemapPaths(xml), ["/", "/lol/next-patch/"]);
});

test("a publisher's own words are not mistaken for a placeholder", () => {
    // The false-refusal direction, which is as damaging as a missed one: a refusal stops the site
    // updating at all and the cause is invisible. `data.notes` is copied into the page from the source,
    // so an update actually titled "Loading..." used to block every publish from then on (Codex, #69).
    const build = healthyBuild();
    try {
        const page = trackerPages()[0].page;
        const file = path.join(build.dir, page);
        const html = fs.readFileSync(file, "utf8")
            .replace("<h1>", "<h1>Patch notes: fixed a NaN in the damage formula, and Loading... screens</h1><h1>");
        fs.writeFileSync(file, html, "utf8");
        assert.deepEqual(refusals(build.dir), [], "prose outside the rendered slots was read as a placeholder");
    } finally {
        build.cleanup();
    }
});

test("a sitemap that lists nothing is refused", () => {
    // Existing is not the same as usable. An empty or truncated file parses to no locations, every other
    // sitemap check passes vacuously, and the site publishes asking to be indexed through a file naming
    // no pages.
    const build = healthyBuild();
    try {
        fs.writeFileSync(path.join(build.dir, "sitemap.xml"), `<?xml version="1.0"?>
<urlset>
</urlset>
`, "utf8");
        assert.match(refusals(build.dir).join(" | "), /the sitemap lists 0 page\(s\) but \d+ are indexable/);
    } finally {
        build.cleanup();
    }
});

test("a sitemap missing an indexable page is refused", () => {
    const build = healthyBuild();
    try {
        const dropped = trackerPages()[0].page;
        writeSitemap(build.dir, pagePaths().filter(page =>
            page !== "404.html" && page !== "play/index.html" && page !== dropped));
        assert.match(refusals(build.dir).join(" | "), /missing: \/[^,\s]+/);
    } finally {
        build.cleanup();
    }
});

test("a page the manifest does not declare is refused", () => {
    // renderSite treats an unfamiliar non-tracker page as indexable static content and puts it in the
    // sitemap, so a stray file under public/ would be force-published and submitted for indexing. The
    // suite checks both directions; the publish job does not run the suite.
    const build = healthyBuild();
    try {
        const stray = path.join(build.dir, "scratch", "index.html");
        fs.mkdirSync(path.dirname(stray), { recursive: true });
        fs.writeFileSync(stray, "<!DOCTYPE html><html><head></head><body><h1>notes to self</h1></body></html>", "utf8");
        assert.match(refusals(build.dir).join(" | "), /the manifest does not declare: scratch\/index\.html/);
    } finally {
        build.cleanup();
    }
});
