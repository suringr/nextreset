/**
 * The last check before dist/ replaces the live site.
 *
 * Publishing here is destructive: the deploy step force-pushes an orphan commit over `gh-pages`, so a
 * bad build does not sit alongside the good one, it replaces it. And the publish job runs `build:site`
 * without `npm test`, so nothing in the suite stands between a broken render and the live site. That
 * combination is the reason this file exists: the checks that matter at publish time have to run at
 * publish time, against the artefact, and they have to fail closed.
 *
 * It reads `dist/` rather than the renderer's summary on purpose. A summary describes what the renderer
 * believed it was doing; the files are what visitors and crawlers will actually receive, and the two
 * have disagreed before.
 *
 * What it will not do is refuse a publish because the data is disappointing. A provider failing is an
 * ordinary day: the pages say so honestly, the trackers that still answer are unaffected, and shipping
 * that is right. It refuses only where publishing would leave the site worse than not publishing at all.
 */
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { declaresNoindex } from "./indexing";
import { readHealth, unexpectedlyDegraded } from "./refresh-health";
import { pagePaths, trackerPages } from "./site-map";

/** Strings that mean the renderer did not finish. None of them should ever reach a reader. */
const PLACEHOLDERS = ["--:--", "Checking official sources", "Loading...", "NaN", "Invalid Date", "undefined UTC"];

export interface GateFinding {
    /** `refuse` blocks the publish; `warn` is reported and shipped. */
    level: "refuse" | "warn";
    message: string;
}

export interface GateReport {
    findings: GateFinding[];
    pages: number;
    indexable: string[];
    noindex: string[];
    sitemap: string[];
}

function htmlFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (at: string) => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) out.push(path.relative(dir, full).split(path.sep).join("/"));
        }
    };
    walk(dir);
    return out.sort();
}

/** The `<loc>` paths a sitemap lists, as site-relative URL paths. */
export function sitemapPaths(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)]
        .map(match => match[1])
        .map(location => { try { return new URL(location).pathname; } catch { return location; } })
        .sort();
}

/** The URL path a built page is served at: "lol/next-patch/index.html" -> "/lol/next-patch/". */
function urlPathOfFile(page: string): string {
    return "/" + page.replace(/index\.html$/, "").replace(/^\/+/, "");
}

export function inspect(distDir: string): GateReport {
    const findings: GateFinding[] = [];
    const pages = htmlFiles(distDir);
    const indexable: string[] = [];
    const noindex: string[] = [];

    for (const page of pages) {
        const html = fs.readFileSync(path.join(distDir, page), "utf8");
        // Only where the renderer writes, never the whole document.
        //
        // A substring search over the source would refuse a deploy because a publisher used one of these
        // words. `data.notes` is copied into the page from the source, so an update actually titled
        // "Loading..." — or any title containing "NaN" — would block every publish from then on
        // (Codex, #69). A false refusal here is as damaging as a missed one: it stops the site updating
        // at all, and the cause would be invisible.
        const $ = cheerio.load(html);
        const written = $("[data-nr-slot], [data-nr-region], .countdown-value, .countdown-label").text();
        for (const placeholder of PLACEHOLDERS) {
            if (written.includes(placeholder)) {
                findings.push({ level: "refuse", message: `${page} still shows "${placeholder}" where a value should be` });
            }
        }
        (declaresNoindex(html) ? noindex : indexable).push(page);
    }

    // The build and the manifest have to agree, in both directions.
    //
    // A declared page that was not produced is a 404 on a URL that was in yesterday's sitemap. An
    // undeclared page that *was* produced is worse in a different way: `renderSite` treats an unfamiliar
    // non-tracker page as indexable static content and puts it in the sitemap, so a stray file under
    // public/ gets force-published and submitted for indexing. The suite checks both directions and the
    // publish job does not run the suite (Codex, #69).
    const declared = pagePaths();
    const missing = declared.filter(page => !pages.includes(page));
    if (missing.length > 0) {
        findings.push({ level: "refuse", message: `the build is missing ${missing.length} declared page(s): ${missing.join(", ")}` });
    }
    const undeclared = pages.filter(page => !declared.includes(page));
    if (undeclared.length > 0) {
        findings.push({ level: "refuse", message: `the build produced ${undeclared.length} page(s) the manifest does not declare: ${undeclared.join(", ")}` });
    }

    // A build in which no tracker can answer anything is not this site. Publishing it over a working one
    // replaces every answer with "Data unavailable", and because the deploy force-pushes, yesterday's
    // good site is gone.
    //
    // Asked of the trackers specifically, not of the build as a whole: /about/ and /privacy/ are static
    // and always indexable, so "is anything indexable" would be satisfied by pages that cannot fail and
    // the check would never fire. The question is whether a single tracker still answers its question,
    // which is the signature of a systemic failure — no network, an empty store, a renderer that threw —
    // rather than of a publisher having a quiet week.
    const trackers = new Set(trackerPages().map(entry => entry.page));
    const answering = indexable.filter(page => trackers.has(page));
    if (answering.length === 0) {
        findings.push({
            level: "refuse",
            message: `none of the ${trackers.size} trackers is indexable in this build; refusing to replace the live site with one where nothing answers`
        });
    }

    // The sitemap and the robots tag have to answer the same question the same way. Asking a crawler to
    // index a page that asks not to be indexed teaches it to trust neither signal.
    const sitemapFile = path.join(distDir, "sitemap.xml");
    let sitemap: string[] = [];
    if (!fs.existsSync(sitemapFile)) {
        findings.push({ level: "refuse", message: "the build has no sitemap.xml" });
    } else {
        sitemap = sitemapPaths(fs.readFileSync(sitemapFile, "utf8"));
        const noindexPaths = new Set(noindex.map(urlPathOfFile));
        const builtPaths = new Set(pages.map(urlPathOfFile));
        for (const location of sitemap) {
            if (noindexPaths.has(location)) {
                findings.push({ level: "refuse", message: `${location} is in the sitemap and asks not to be indexed` });
            } else if (!builtPaths.has(location)) {
                findings.push({ level: "refuse", message: `${location} is in the sitemap but was not built` });
            }
        }
        // Existing is not the same as usable. An empty or truncated sitemap parses to nothing, every
        // check above passes vacuously, and the site publishes asking to be indexed through a file that
        // lists no pages (Codex, #69). The sitemap and the robots tags are two answers to one question,
        // so they have to name the same set.
        const shouldList = indexable.map(urlPathOfFile).sort();
        const listed = [...sitemap].sort();
        if (listed.length !== shouldList.length || listed.some((location, at) => location !== shouldList[at])) {
            const absent = shouldList.filter(location => !listed.includes(location));
            findings.push({
                level: "refuse",
                message: `the sitemap lists ${listed.length} page(s) but ${shouldList.length} are indexable` +
                    (absent.length > 0 ? `; missing: ${absent.join(", ")}` : "")
            });
        }
    }

    // Reported, never fatal. A provider failing is an ordinary day and the pages say so honestly; this
    // exists so the run is not silent about it. The workflow decides what turns the run red.
    if (fs.existsSync(path.join(distDir, "..", "build", "refresh.failed"))) {
        findings.push({ level: "warn", message: "the data refresh did not finish this run; the site is publishing its last known good values" });
    }
    const health = readHealth();
    if (health) {
        for (const provider of health.providers.filter(p => p.status !== "fresh")) {
            findings.push({
                level: "warn",
                message: `${provider.game}/${provider.type} is ${provider.status}${provider.detail ? `: ${provider.detail}` : ""}`
            });
        }
        for (const provider of unexpectedlyDegraded(health)) {
            findings.push({
                level: "warn",
                message: `${provider.game}/${provider.type} is ${provider.status} and its page is still offered to readers — nobody has accepted this stop`
            });
        }
    }

    return { findings, pages: pages.length, indexable, noindex, sitemap };
}

if (require.main === module) {
    const dist = path.resolve(__dirname, "..", "dist");
    if (!fs.existsSync(dist)) {
        console.error("❌ No dist/ to check. Run export:site and render:pages first.");
        process.exit(1);
    }
    const report = inspect(dist);
    const refusals = report.findings.filter(finding => finding.level === "refuse");
    const warnings = report.findings.filter(finding => finding.level === "warn");

    console.log(`  publish gate: ${report.pages} page(s), ${report.indexable.length} indexable, ${report.noindex.length} noindex, ${report.sitemap.length} in the sitemap`);
    // GitHub reads these annotations; locally they are just a line of text.
    for (const warning of warnings) console.warn(`::warning title=Publish gate::${warning.message}`);
    for (const refusal of refusals) console.error(`::error title=Publish gate::${refusal.message}`);

    if (refusals.length > 0) {
        console.error(`❌ Publish gate refused this build: ${refusals.length} problem(s) above. dist/ was not published.`);
        process.exit(1);
    }
    console.log("✅ Publish gate passed.");
}
