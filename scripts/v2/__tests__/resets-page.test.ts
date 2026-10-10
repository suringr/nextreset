/**
 * `/resets/` — the hub, and the promises it makes.
 *
 * Two of them matter more than the rest. The table has to be complete before any script runs, because
 * that is the whole difference between a page a crawler can read and the twelve cards that said
 * "Loading..." before Publishing V2. And a tracker withheld from the index has to appear here with its
 * real value and no link, because that is the deal the editorial list made: the page is not worth
 * recommending, the data still is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { adsenseLoaderCount } from "../../adsense";
import { EDITORIAL_NOINDEX, isListed } from "../../indexing";
import { GameKnowledge } from "../../render-data-blocks";
import { TrackerData, renderSite } from "../../render-pages";
import { ResetRow, SOON_DAYS, cadenceOf, renderResetsHtml, resetRows } from "../../render-resets";
import { trackerPages } from "../../site-map";
import { gamePages } from "../../update-game-pages";

const ROOT = path.join(__dirname, "..", "..", "..");
const PUBLIC = path.join(ROOT, "public");
const PAGE = fs.readFileSync(path.join(PUBLIC, "resets", "index.html"), "utf8");
const NOW = new Date("2026-10-01T12:00:00.000Z");

/** A tracker that answers, at the instant given, to the second. */
const answered = (game: string, type: string, at: string, precision = "exact"): TrackerData => ({
    game, type, status: "fresh", nextEventUtc: at, precision,
    fetched_at_utc: NOW.toISOString(), last_success_at_utc: NOW.toISOString(),
    source_url: "https://example.com", confidence: "high"
});

/** Every tracker answering, spread so the ordering has something to order. */
function allAnswering(): (game: string, type: string) => TrackerData | undefined {
    const at = new Map<string, string>([
        ["gta/weekly-reset", "2026-10-08T10:00:00.000Z"],   // upcoming, inside the week
        ["genshin/next-banner", "2026-10-13T09:59:00.000Z"], // upcoming, outside the week
        ["lol/next-patch", "2026-10-07T00:00:00.000Z"],      // upcoming, inside the week
        ["fortnite/next-season", "2026-11-01T00:00:00.000Z"] // upcoming, far out
    ]);
    return (game, type) => {
        const key = `${game}/${type}`;
        if (at.has(key)) return answered(game, type, at.get(key)!);
        // Everything else is a "last" tracker: a past instant, newest first once sorted.
        const index = gamePages.findIndex(entry => entry.game === game && entry.type === type);
        return answered(game, type, new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString());
    };
}

const rowsNow = (knowledge: (game: string) => GameKnowledge | undefined = () => undefined): ResetRow[] =>
    resetRows({ read: allAnswering(), knowledge, now: NOW });

test("every tracker the site has is a row, including the ones withheld from the index", () => {
    const rows = rowsNow();
    assert.equal(rows.length, trackerPages().length);
    assert.deepEqual(
        rows.map(row => `${row.game}/${row.type}`).sort(),
        gamePages.map(entry => `${entry.game}/${entry.type}`).sort(),
        "the hub and the tracker registry disagree about which games exist"
    );
    // The point of the hub: a withheld tracker's data is still here.
    for (const { page } of EDITORIAL_NOINDEX) {
        const entry = trackerPages().find(candidate => candidate.page === page)!;
        const row = rows.find(r => r.game === entry.tracker!.game && r.type === entry.tracker!.type);
        assert.ok(row, `${page} is withheld and missing from the hub entirely`);
        assert.notEqual(row!.when.trim(), "", `${page} is a row with nothing in it`);
    }
});

test("a row links to its tracker only where that tracker is worth reading", () => {
    for (const row of rowsNow()) {
        const page = `${row.game}/${row.type}/index.html`;
        if (isListed(page)) {
            assert.equal(row.href, `/${row.game}/${row.type}/`, `${page} is listed but the hub does not link it`);
        } else {
            assert.equal(row.href, undefined, `${page} is withheld but the hub links to it anyway`);
        }
    }
});

test("the table is complete before any script runs", () => {
    // The promise Publishing V2 exists to keep. Asked of the rendered HTML, with the scripts stripped.
    const html = renderResetsHtml(PAGE, rowsNow());
    const $ = cheerio.load(html);
    $("script").remove();
    const body = $("tbody").text().replace(/\s+/g, " ");

    for (const row of rowsNow()) {
        assert.ok(body.includes(row.title), `${row.title} is not in the served table`);
        assert.ok(body.includes(row.when), `${row.title}'s value "${row.when}" is not in the served table`);
    }
    assert.equal($("tbody tr").length, trackerPages().length);
    assert.ok(!body.includes("Loading"), "the table was served with a placeholder in it");
    assert.ok(!body.includes("--:--"), "the table was served with a placeholder in it");
});

test("the visitor's own clock is an enhancement, never the value", () => {
    const html = renderResetsHtml(PAGE, rowsNow());
    const $ = cheerio.load(html);
    // Served empty with an em dash: a reader without JavaScript sees the UTC column and nothing broken.
    for (const cell of $(".reset-local").toArray()) {
        assert.equal($(cell).text().trim(), "—", "a local-time cell was served with a value in it");
    }
    // And only where the source gave an exact instant, since a date has no time to convert.
    for (const row of rowsNow()) {
        const cells = $(`.reset-local[data-utc="${row.atIso}"]`);
        if (row.exact) assert.ok(cells.length >= 1, `${row.title} is exact but has nothing to convert`);
    }
});

test("the browser fills the local column from the UTC already in the row, and never guesses", () => {
    const context: Record<string, any> = {
        console, Intl, setInterval: () => 0, clearTimeout: () => undefined, setTimeout: () => 0
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, "assets", "app.js"), "utf8"), context, { filename: "app.js" });

    const made = (utc: string) => ({
        value: utc, textContent: "—", removed: false,
        getAttribute() { return this.value; },
        classList: { remove: () => undefined }
    });
    const good = made("2026-10-08T10:00:00.000Z");
    const bad = made("not-a-date");
    const filled = context.fillLocalTimes({ querySelectorAll: () => [good, bad] });

    assert.equal(filled, 1, "exactly one cell could be converted");
    assert.notEqual(good.textContent, "—", "a convertible instant was left unconverted");
    assert.ok(/2026/.test(good.textContent), "the converted value does not name the year");
    assert.equal(bad.textContent, "—", "an unreadable instant must keep its em dash, not show a wrong time");
});

test("a row inside the coming week says so, and one outside it does not", () => {
    const rows = rowsNow();
    const soon = rows.filter(row => row.soon);
    assert.ok(soon.length > 0, "nothing is marked as coming up, with two events inside the week");
    for (const row of rows) {
        if (row.at === undefined) {
            assert.equal(row.soon, false, `${row.title} has no instant but is marked soon`);
            continue;
        }
        const ahead = row.at > NOW.getTime();
        const within = row.at - NOW.getTime() <= SOON_DAYS * 86_400_000;
        assert.equal(row.soon, ahead && within, `${row.title}: soon=${row.soon} for an event at ${new Date(row.at).toISOString()}`);
    }
});

test("what is coming up is first, soonest first; what happened is next, newest first", () => {
    const rows = rowsNow();
    const upcoming = rows.filter(row => row.upcoming && row.at !== undefined);
    const recent = rows.filter(row => !row.upcoming && row.at !== undefined);

    assert.ok(upcoming.length > 0 && recent.length > 0, "this test needs some of each");
    assert.deepEqual(rows.slice(0, upcoming.length).map(r => r.title), upcoming.map(r => r.title), "upcoming is not first");
    for (let i = 1; i < upcoming.length; i++) {
        assert.ok(upcoming[i].at! >= upcoming[i - 1].at!, "upcoming is not soonest-first");
    }
    for (let i = 1; i < recent.length; i++) {
        assert.ok(recent[i].at! <= recent[i - 1].at!, "recent is not newest-first");
    }
});

test("cadence is a rule the publisher states, or a rhythm the history shows, or nothing", () => {
    const every = (days: number, count: number): GameKnowledge => ({
        game: "x",
        events: Array.from({ length: count }, (_, i) => ({
            key: `x/t/${i}`, topic: "t", label: `${i}`, status: "observed",
            at: new Date(Date.UTC(2026, 0, 1 + i * days)).toISOString(), publishState: "published"
        })),
        claims: []
    });

    // A stated rule wins outright: it is what the publisher says, not what we have observed.
    assert.equal(cadenceOf(every(14, 8), "t", "Every Thursday, 10:00 UTC"), "Every Thursday, 10:00 UTC");

    // Evenly spaced history reads as a rhythm, hedged, because it describes what happened.
    assert.equal(cadenceOf(every(14, 8), "t"), "About every 2 weeks");
    assert.equal(cadenceOf(every(7, 6), "t"), "About weekly");
    assert.equal(cadenceOf(every(1, 6), "t"), "About daily");
    assert.equal(cadenceOf(every(10, 6), "t"), "About every 10 days");

    // Too little history to call anything a rhythm: three events is two gaps.
    assert.equal(cadenceOf(every(14, 3), "t"), undefined);
    assert.equal(cadenceOf(undefined, "t"), undefined);

    // A real schedule with real exceptions still reads as the schedule. These are League of Legends'
    // own gaps: twenty-one fortnights and two split breaks. Demanding every gap agree would throw away
    // a two-week cycle that exists because Riot takes Christmas off.
    const lol: GameKnowledge = {
        game: "lol", claims: [],
        events: [14, 13, 15, 13, 14, 14, 14, 14, 14, 15, 13, 14, 21, 14, 14, 14, 15, 13, 14, 14, 14, 14, 21]
            .reduce<{ day: number; events: any[] }>((acc, gap, i) => {
                acc.events.push({
                    key: `lol/t/${i}`, topic: "t", label: `${i}`, status: "observed",
                    at: new Date(Date.UTC(2026, 0, 1 + acc.day)).toISOString(), publishState: "published"
                });
                acc.day += gap;
                return acc;
            }, { day: 0, events: [] }).events
    };
    assert.equal(cadenceOf(lol, "t"), "About every 2 weeks");

    // Uneven history is not a rhythm, and must not be reported as one. This is Counter-Strike: Valve
    // ships when it is ready, and "about every 9 days" would be an invented promise.
    const uneven: GameKnowledge = {
        game: "x",
        events: ["2026-01-01", "2026-01-02", "2026-01-20", "2026-02-28", "2026-03-01"].map((day, i) => ({
            key: `x/t/${i}`, topic: "t", label: `${i}`, status: "observed",
            at: `${day}T00:00:00.000Z`, publishState: "published"
        })),
        claims: []
    };
    assert.equal(cadenceOf(uneven, "t"), undefined);
});

test("an instant that has just passed is still an instant, not the homepage's placeholder", () => {
    // Codex, PR #65: cardValue says "Updating..." for an exact future-facing event whose moment has
    // gone, because it is a live countdown with nothing left to count to. A table of facts still knows
    // the instant. Copying the placeholder put it in the UTC column while the column beside it showed
    // that same instant converted — the table contradicting itself, in the one place this project
    // promises a crawler sees the real value.
    const justPassed = new Date("2026-10-08T10:00:01.000Z");
    const rows = resetRows({
        read: (game, type) => (game === "gta" ? answered("gta", "weekly-reset", "2026-10-08T10:00:00.000Z") : undefined),
        knowledge: () => undefined,
        now: justPassed
    });
    const gta = rows.find(row => row.game === "gta")!;
    assert.ok(!/Updating/.test(gta.when), `the UTC column published a placeholder: ${gta.when}`);
    assert.match(gta.when, /October 8, 2026 at 10:00 UTC/);

    // And the two columns agree: whatever the UTC cell says, the local cell converts the same instant.
    const html = renderResetsHtml(PAGE, rows);
    const $ = cheerio.load(html);
    const cell = $(`.reset-local[data-utc="${gta.atIso}"]`);
    assert.equal(cell.length, 1, "the local cell is not offered the instant the UTC cell shows");
});

test("an abandoned rhythm is not a cadence", () => {
    // Codex, PR #65: four weekly gaps and then a two-year silence is four fifths "close to the median",
    // which the ratio test alone published as "About weekly" for a game nobody has touched since.
    const at = (days: number[]): GameKnowledge => ({
        game: "x", claims: [],
        events: days.map((day, i) => ({
            key: `x/t/${i}`, topic: "t", label: `${i}`, status: "observed",
            at: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(), publishState: "published"
        }))
    });
    const nowAfter = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

    // Weekly, then gone for two years. The ratio is 4/5; the outlier is 104x the median.
    const abandoned = at([0, 7, 14, 21, 28, 28 + 730]);
    assert.equal(cadenceOf(abandoned, "t", undefined, nowAfter(28 + 731)), undefined);
    assert.equal(cadenceOf(abandoned, "t"), undefined, "the magnitude cap applies without a clock too");

    // A break of twice the median is a break, and the rhythm survives it.
    const withBreak = at([0, 14, 28, 42, 56, 84, 98, 112]);
    assert.equal(cadenceOf(withBreak, "t", undefined, nowAfter(113)), "About every 2 weeks");

    // A rhythm that stopped longer ago than the rhythm itself is not a present-tense claim any more.
    assert.equal(cadenceOf(at([0, 14, 28, 42, 56]), "t", undefined, nowAfter(57)), "About every 2 weeks");
    assert.equal(cadenceOf(at([0, 14, 28, 42, 56]), "t", undefined, nowAfter(56 + 60)), undefined);
});

test("an old hiatus stops counting once the rhythm has resumed", () => {
    // Codex, PR #65 round 2: the magnitude cap applied to every gap a game had ever had, so one
    // three-week break in its past suppressed the cadence forever, however many weekly releases
    // followed. That contradicted the rule it sits next to, which exists to tolerate breaks.
    //
    // "How often" is a claim about now, so it is judged on the recent window. The hiatus falls out of
    // it once the rhythm has resumed; a two-year silence with one release after it is still in it.
    const from = (days: number[]): GameKnowledge => ({
        game: "x", claims: [],
        events: days.map((day, i) => ({
            key: `x/t/${i}`, topic: "t", label: `${i}`, status: "observed",
            at: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(), publishState: "published"
        }))
    });
    const weekly = (count: number, from0 = 0) => Array.from({ length: count }, (_, i) => from0 + i * 7);
    const nowAfter = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

    // A long hiatus, then twelve weeks of weekly releases. The game is weekly.
    const resumed = [0, 7, 14, 21 + 90, ...weekly(12, 21 + 90 + 7)];
    const last = resumed[resumed.length - 1];
    assert.equal(cadenceOf(from(resumed), "t", undefined, nowAfter(last + 1)), "About weekly");

    // The same hiatus, but only three releases since: it is still inside the window and still says
    // nothing reliable, so the cadence stays unreported rather than being guessed at.
    const barelyResumed = [0, 7, 14, 21 + 90, 21 + 97, 21 + 104];
    assert.equal(cadenceOf(from(barelyResumed), "t", undefined, nowAfter(21 + 105)), undefined);

    // And the abandonment case from round 1 still fails, because its gap is in the recent window.
    const abandoned = [0, 7, 14, 21, 28, 28 + 730];
    assert.equal(cadenceOf(from(abandoned), "t", undefined, nowAfter(28 + 731)), undefined);
});

test("a tracker the registry has lost fails the build rather than vanishing from the table", () => {
    // Codex, PR #65: this used to `continue`, so drift published a table quietly missing a game while
    // still passing the "not empty" check — and the publish job does not run these tests.
    const rows = () => resetRows({
        read: () => undefined,
        knowledge: () => undefined,
        now: NOW
    });
    assert.doesNotThrow(rows, "the registry and the manifest already disagree");

    const original = gamePages.splice(0, 1)[0];
    try {
        assert.throws(rows, /absent from the tracker registry/);
    } finally {
        gamePages.unshift(original);
    }
    assert.doesNotThrow(rows, "the registry was not restored");
});

test("the hub refuses to publish an empty or undeclared table", () => {
    // The same rule the tracker pages follow: a page that cannot say what it knows fails the build
    // rather than being served with a hole in it.
    assert.throws(() => renderResetsHtml(PAGE, []), /no trackers to list/);
    assert.throws(() => renderResetsHtml("<table><tbody></tbody></table>", rowsNow()), /expected exactly one "resets" region/);
    const twice = PAGE.replace(`<tbody data-nr-region="resets">`, `<tbody data-nr-region="resets"></tbody><tbody data-nr-region="resets">`);
    assert.throws(() => renderResetsHtml(twice, rowsNow()), /expected exactly one "resets" region/);
});

test("the hub is a page of the site: indexed, canonical, breadcrumbed, and carrying the ad code", () => {
    const $ = cheerio.load(PAGE);
    assert.equal($(`link[rel="canonical"]`).attr("href"), "https://nextreset.co/resets/");
    assert.equal($(`meta[name="robots"]`).length, 0, "the hub asks to be indexed");
    assert.equal(adsenseLoaderCount(PAGE), 1, "a content page carries the loader exactly once");
    assert.equal($("h1").length, 1);
    assert.equal($(".breadcrumbs").length, 1);
    assert.equal($(`.chrome-nav a[href="/resets/"]`).attr("aria-current"), "page", "the nav does not mark the hub as current");
    const crumbs = $(`script[type="application/ld+json"]`).toArray()
        .map(node => JSON.parse($(node).html() ?? "{}"))
        .filter(schema => schema["@type"] === "BreadcrumbList");
    assert.equal(crumbs.length, 1);
    assert.equal(crumbs[0].itemListElement[1].name, $(`.breadcrumbs [aria-current="page"]`).text().trim());
});

test("a real build renders the hub and submits it", () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "nextreset-resets-"));
    const copy = (from: string, to: string) => {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const a = path.join(from, entry.name);
            const b = path.join(to, entry.name);
            if (entry.isDirectory()) copy(a, b); else fs.copyFileSync(a, b);
        }
    };
    copy(PUBLIC, dist);
    fs.mkdirSync(path.join(dist, "data"), { recursive: true });
    const read = allAnswering();
    for (const entry of trackerPages()) {
        const { game, type } = entry.tracker!;
        fs.writeFileSync(path.join(dist, "data", `${game}.${type}.json`), JSON.stringify(read(game, type)));
    }

    const summary = renderSite(dist, NOW, dist);
    assert.equal(summary.resets, trackerPages().length, "the hub did not list every tracker");
    const hub = summary.sitemap.find(entry => entry.loc === "https://nextreset.co/resets/");
    assert.ok(hub, "the hub is not in the sitemap");
    // Codex, PR #65: a page rebuilt from twelve moving facts was being dated like About and Privacy,
    // which genuinely never change. It is as new as the newest thing on it, exactly as the homepage is.
    const home = summary.sitemap.find(entry => entry.loc === "https://nextreset.co/");
    assert.equal(hub!.lastmod, home!.lastmod, "the hub and the homepage show the same facts and must be dated alike");

    const html = fs.readFileSync(path.join(dist, "resets", "index.html"), "utf8");
    const $ = cheerio.load(html);
    assert.equal($("tbody tr").length, trackerPages().length);
    assert.equal($(`meta[name="robots"]`).length, 0, "the hub was rendered noindex");
    // Withheld trackers: present, and not linked, in the page that actually ships.
    for (const { page } of EDITORIAL_NOINDEX) {
        const [game, type] = page.split("/");
        assert.equal($(`tbody a[href="/${game}/${type}/"]`).length, 0, `${page} is linked from the shipped hub`);
    }
    fs.rmSync(dist, { recursive: true, force: true });
});
