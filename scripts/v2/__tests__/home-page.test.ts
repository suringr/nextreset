/**
 * Publishing V2, milestone 4: the homepage publishes what it knows.
 *
 * It used to ship twelve cards that said "Loading...", so the page a crawler saw contained no dates at
 * all. These tests cover the three things that has to get right: every card carries its verified value,
 * the order comes from the data rather than from the order the cards were authored in, and the browser
 * reaches the same conclusion the build did — a stale value is stale in both, an expired one is neither
 * LIVE nor counting down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { TrackerData } from "../../render-pages";
import { GROUP_HEADINGS, cardValue, readCard, renderHomeHtml } from "../../render-home";

const ROOT = path.join(__dirname, "..", "..", "..");
const HOME = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const NOW = new Date("2026-09-16T12:00:00Z");

function data(over: Partial<TrackerData>): TrackerData {
    return {
        status: "fresh",
        fetched_at_utc: "2026-09-16T11:00:00.000Z",
        last_success_at_utc: "2026-09-16T11:00:00.000Z",
        source_url: "https://example.test/",
        confidence: "high",
        ...over
    };
}

/** The twelve trackers as the site actually publishes them, on the day NOW names. */
const PUBLISHED: Record<string, TrackerData> = {
    // Upcoming, soonest last on purpose: the page has to reorder them.
    "lol.next-patch": data({ game: "lol", type: "next-patch", nextEventUtc: "2026-09-23T00:00:00.000Z", precision: "day" }),
    "genshin.next-banner": data({ game: "genshin", type: "next-banner", nextEventUtc: "2026-09-22T06:59:59.000Z", precision: "exact" }),
    "gta.weekly-reset": data({ game: "gta", type: "weekly-reset", nextEventUtc: "2026-09-17T10:00:00.000Z", precision: "exact" }),
    // Recently updated.
    "cs2.last-update": data({ game: "cs2", type: "last-update", nextEventUtc: "2026-09-09T22:51:08.000Z", precision: "exact" }),
    "valorant.last-patch": data({ game: "valorant", type: "last-patch", nextEventUtc: "2026-09-01T13:00:00.000Z", precision: "exact" }),
    "minecraft.last-release": data({ game: "minecraft", type: "last-release", nextEventUtc: "2026-09-15T11:23:02.000Z", precision: "exact" }),
    "warzone.last-patch": data({ game: "warzone", type: "last-patch", nextEventUtc: "2026-09-16T00:00:00.000Z", precision: "day" }),
    "pubg.last-patch": data({ game: "pubg", type: "last-patch", nextEventUtc: "2026-09-10T00:00:00.000Z", precision: "day" }),
    "roblox.status": data({ game: "roblox", type: "status", nextEventUtc: "2026-08-07T04:48:28.252Z", precision: "exact" }),
    "red-dead-redemption-2.last-update": data({ game: "red-dead-redemption-2", type: "last-update", nextEventUtc: "2026-09-01T00:00:00.000Z", precision: "day" }),
    // An unreachable source: the value still stands, but it is stale on the side of the date it is on.
    "ea-sports-fc.last-title-update": data({ game: "ea-sports-fc", type: "last-title-update", status: "stale", nextEventUtc: "2026-08-20T00:00:00.000Z", precision: "day", last_success_at_utc: "2026-09-01T00:00:00.000Z" }),
    // Fortnite as it really was: a June date, still published in September, on a crashed V1 provider.
    "fortnite.next-season": data({ game: "fortnite", type: "next-season", status: "stale", nextEventUtc: "2026-06-06T00:00:00.000Z", last_success_at_utc: "2026-04-05T21:30:13.065Z", reason: "Crashed: Fetch failed: undefined (Status: 403)" })
};

const read = (game: string, type: string): TrackerData | undefined => PUBLISHED[`${game}.${type}`];
const rendered = renderHomeHtml(HOME, read, NOW);

/** The card blocks of a rendered page, in the order they appear. */
function cardsOf(html: string): string[] {
    return html.match(/<a\b[^>]*class="card"[^>]*>[\s\S]*?<\/a>/g) ?? [];
}

test("every card carries its verified value, and nothing is left loading", () => {
    const cards = cardsOf(rendered.html);
    assert.equal(cards.length, 12, "all twelve trackers are on the page");
    assert.ok(!rendered.html.includes("Loading..."), "no card is still waiting for JavaScript");
    assert.deepEqual(rendered.counts, { upcoming: 3, recent: 8, unknown: 1 });

    const lol = cards.find(c => c.includes(`id="card-lol"`))!;
    assert.ok(lol.includes("September 23, 2026"), "a date-only value is published as the date it is");
    assert.ok(!lol.includes("00:00 UTC"), "and never as a midnight that was never announced");

    const gta = cards.find(c => c.includes(`id="card-gta"`))!;
    assert.ok(gta.includes("September 17, 2026 at 10:00 UTC"), "an exact instant keeps its time");
});

test("the page is ordered by what the data says, not by the order the cards were written in", () => {
    const html = rendered.html;
    const headings = [...html.matchAll(/class="group-heading"[^>]*>([^<]*)</g)].map(m => m[1]);
    assert.deepEqual(headings, [GROUP_HEADINGS.upcoming, GROUP_HEADINGS.recent, GROUP_HEADINGS.unknown]);

    const ids = cardsOf(html).map(c => /id="card-([^"]+)"/.exec(c)![1]);
    assert.deepEqual(ids.slice(0, 3), ["gta", "genshin", "lol"], "what happens next comes first");
    assert.deepEqual(ids.slice(3, 6), ["warzone", "minecraft", "pubg"], "then the most recently updated");
    assert.equal(ids[ids.length - 1], "fortnite", "and the question nobody has answered comes last");

    // The authored page leads with Fortnite and buries GTA; this must be the data's order, not that one.
    const authored = cardsOf(HOME).map(c => /id="card-([^"]+)"/.exec(c)![1]);
    assert.equal(authored[0], "fortnite");
    assert.notDeepEqual(ids, authored);
});

test("an expired date is not badged LIVE on the homepage either", () => {
    const fortnite = cardsOf(rendered.html).find(c => c.includes(`id="card-fortnite"`))!;
    assert.ok(fortnite.includes("No official date announced"));
    assert.ok(fortnite.includes(">NO DATE<"));
    assert.ok(fortnite.includes(`data-unanswered="1"`), "so the 60-second updater leaves it alone");
    assert.ok(!fortnite.includes("June 6, 2026"), "the passed date is not shown as a value");
    assert.ok(!rendered.html.includes("Crashed"), "and a provider's own message never reaches the page");
});

test("a value whose source could not be reached is stale on either side of its date", () => {
    const eafc = cardsOf(rendered.html).find(c => c.includes(`id="card-ea-sports-fc"`))!;
    assert.ok(eafc.includes(">STALE<"), "a past event with an unreachable source is not LIVE");
    assert.ok(eafc.includes("August 20, 2026"), "the last verified value is still published");
});

test("a future-facing instant that has just passed says so rather than pretending it is ahead", () => {
    const justPassed = data({ game: "gta", type: "weekly-reset", nextEventUtc: "2026-09-16T10:00:00.000Z", precision: "exact" });
    const value = cardValue(justPassed, NOW);
    assert.equal(value.value, "Updating...", "the same words app.js uses for this moment");
    assert.equal(value.group, "upcoming");
    assert.equal(value.badgeText, "LIVE", "it was verified an hour ago; only the next value is pending");
});

test("a date-only value stays its date, and stays next up, for the whole day it names", () => {
    const app = loadApp();
    // The patch is announced for the 23rd. At midday on the 23rd its stored midnight has passed, but the
    // day it names has not: the answer is still "September 23, 2026".
    const midday = new Date("2026-09-23T12:00:00Z");
    const built = cardValue(PUBLISHED["lol.next-patch"], midday);
    assert.equal(built.value, "September 23, 2026", "not 'Updating...' for the whole announced day");
    assert.equal(built.group, "upcoming", "and it is still what happens next");

    const display = app.eventDisplay(PUBLISHED["lol.next-patch"], midday.getTime());
    assert.equal(display.mode, "date", "the browser reaches the same conclusion");

    // The day after, nothing has replaced it, so it stops being an answer at all.
    const tomorrow = new Date("2026-09-24T12:00:00Z");
    assert.equal(cardValue({ ...PUBLISHED["lol.next-patch"], status: "stale" }, tomorrow).value, "No official date announced");
});

test("an exact instant that has just passed is the one case that says Updating", () => {
    const justPassed = { ...PUBLISHED["gta.weekly-reset"], nextEventUtc: "2026-09-16T10:00:00.000Z" };
    assert.equal(cardValue(justPassed, NOW).value, "Updating...");
    assert.equal(cardValue({ ...justPassed, precision: "day" }, NOW).value, "September 16, 2026", "a date-only value is never in that position");
});

test("a tracker with no published file, or one the pipeline no longer stands behind, says so", () => {
    assert.equal(cardValue(undefined, NOW).value, "Data unavailable");
    assert.equal(cardValue(undefined, NOW).badgeText, "UNAVAILABLE");
    assert.equal(cardValue(data({ status: "unavailable", nextEventUtc: "2026-09-23T00:00:00.000Z" }), NOW).value, "Data unavailable");
    assert.equal(cardValue(data({ confidence: "none", nextEventUtc: "2026-09-23T00:00:00.000Z" }), NOW).value, "Data unavailable");
});

test("the checked line is an absolute time, because a cached page cannot keep saying '2 hours ago'", () => {
    const value = cardValue(PUBLISHED["lol.next-patch"], NOW);
    assert.equal(value.checked, "Checked September 16, 2026 at 11:00 UTC");
});

test("data cannot inject markup into a card", () => {
    const nasty = data({ game: "lol", type: "next-patch", nextEventUtc: "2026-09-23T00:00:00.000Z", precision: `day" onload="alert(1)`, status: `fresh"><script>x</script>` });
    const html = renderHomeHtml(HOME, (g, t) => (g === "lol" ? nasty : read(g, t)), NOW).html;
    assert.ok(!html.includes(`onload="alert(1)"`), "an attribute cannot be broken out of");
    assert.ok(!html.includes("<script>x</script>"), "nor a tag introduced");
    assert.ok(html.includes("&quot;"), "the attempt is published as text");
});

test("a homepage the build cannot read fails the build instead of publishing placeholders", () => {
    assert.throws(() => readCard(`<a href="/lol/next-patch/" class="card" id="card-lol" data-game="lol">x</a>`), /missing href\/id/);
    assert.throws(() => renderHomeHtml("<html><body>no cards here</body></html>", read, NOW), /no cards found/);
});

test("a card is recognised by its class, not by how the class attribute is spelled", () => {
    // The cards are replaced as one region, so a card this step failed to see would be deleted rather
    // than left alone. A second class, a different order, single quotes: all still cards.
    const restyled = HOME
        .replace(`class="card" id="card-lol"`, `class="card featured" id="card-lol"`)
        .replace(`class="card" id="card-gta"`, `id="card-gta-anchor" class='promoted card'`);
    const html = renderHomeHtml(restyled, read, NOW).html;
    assert.equal(cardsOf(html).length, 12, "no card was dropped");
    assert.ok(html.includes("September 23, 2026") && html.includes("September 17, 2026 at 10:00 UTC"));

    // An anchor that merely looks card-like is not one, and is left where it is.
    const withLink = HOME.replace(`<div class="grid" id="game-grid">`, `<div class="grid" id="game-grid"><a href="/about/" class="card-link">About</a>`);
    assert.ok(renderHomeHtml(withLink, read, NOW).html.includes(`<a href="/about/" class="card-link">About</a>`));
});

test("content that would be swallowed by the rewrite fails the build instead", () => {
    const withBanner = HOME.replace(`<a href="/lol/next-patch/"`, `<p class="notice">Scheduled maintenance</p>\n      <a href="/lol/next-patch/"`);
    assert.throws(() => renderHomeHtml(withBanner, read, NOW), /unexpected content between cards/);
});

test("the authored shell carries what the build cannot invent", () => {
    assert.ok(HOME.includes(`<link rel="canonical" href="https://nextreset.co/">`), "the homepage had no canonical at all");
    assert.equal(HOME.split(`class="card-topic"`).length - 1, 12, "every card says what its date means");
    assert.ok(!HOME.includes(`<h2 class="card-title"`), "card titles sit under the group headings, not beside them");
});

/** The published app.js, loaded outside a browser, so build and browser can be compared directly. */
function loadApp(): Record<string, any> {
    const context: Record<string, any> = { console, setInterval: () => 0, clearTimeout: () => undefined, setTimeout: () => 0 };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "assets", "app.js"), "utf8"), context, { filename: "app.js" });
    return context;
}

/** A card as the build leaves it: the dataset carries the value, the stubs record what JS writes. */
function stubCard(dataset: Record<string, string>) {
    const els: Record<string, { textContent: string; innerHTML: string; className: string }> = {
        ".badge": { textContent: "", innerHTML: "", className: "" },
        ".card-countdown": { textContent: "", innerHTML: "", className: "" },
        ".last-checked": { textContent: "", innerHTML: "", className: "" }
    };
    return { card: { dataset, querySelector: (sel: string) => els[sel] }, els };
}

test("a refresh that fails leaves the value the build rendered", async () => {
    const app = loadApp();
    const published = stubCard({ game: "lol", type: "next-patch", nextUtc: "2026-09-23T00:00:00.000Z", precision: "day", status: "fresh", checkedUtc: "2026-09-16T11:00:00.000Z", unanswered: "" });
    const nothingPublished = stubCard({ game: "fortnite", type: "next-season", nextUtc: "", precision: "", status: "", checkedUtc: "", unanswered: "" });
    const cards = [published.card, nothingPublished.card];
    app.document = { getElementById: (id: string) => (id === "game-grid" ? { querySelectorAll: () => cards } : null) };
    app.fetchGameData = async () => {
        throw new Error("offline");
    };

    await app.initHomepage();

    assert.equal(published.els[".card-countdown"].textContent, "", "the rendered date is left exactly as it was");
    assert.equal(published.card.dataset.nextUtc, "2026-09-23T00:00:00.000Z", "and the card still knows its date");
    assert.equal(nothingPublished.els[".card-countdown"].textContent, "Data unavailable", "a card with nothing published still says so");
});

test("a tracker page that failed to refresh keeps its rendered value instead of an error box", () => {
    const app = loadApp();
    const rendered = { innerHTML: "the rendered page", querySelector: () => null };
    app.document = { getElementById: () => rendered };
    app.showError("Could not load data for lol.");
    assert.equal(rendered.innerHTML, "the rendered page", "a page carrying a verified value is not replaced");

    // A page the build never rendered still shows the skeleton, and there the error is all we have.
    const skeleton = { innerHTML: "--:--:--", querySelector: (sel: string) => (sel === ".countdown-skeleton" ? {} : null) };
    app.document = { getElementById: () => skeleton };
    app.showError("Could not load data for lol.");
    assert.match(skeleton.innerHTML, /Unable to Load Data/);
});

test("'checked 2 hours ago' keeps counting on a tab left open", () => {
    const app = loadApp();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const { card, els } = stubCard({ game: "lol", type: "next-patch", nextUtc: "", precision: "day", status: "fresh", checkedUtc: threeHoursAgo, unanswered: "" });
    app.document = { querySelectorAll: () => [card] };

    app.updateHomepageCountdowns();

    assert.equal(els[".last-checked"].textContent, "Checked 3 hours ago", "the freshness line is recomputed, not frozen at load");
});

test("a value with no stated precision is a date in the build and in the browser", () => {
    const app = loadApp();
    // Red Dead publishes no precision field: its midnight is storage, not an announced time.
    const redDead = PUBLISHED["red-dead-redemption-2.last-update"];
    const built = cardValue({ ...redDead, precision: undefined }, NOW);
    const display = app.eventDisplay({ ...redDead, precision: undefined }, NOW.getTime());
    assert.equal(built.value, "September 1, 2026");
    assert.deepEqual([display.mode, display.value], ["date", "September 1, 2026"], "the browser shows the same date, not a countdown to midnight");
});

/**
 * Just enough DOM for the updater: elements that know their parent, their children and their classes.
 * The regrouping moves nodes between sections, which cannot be observed through a flat stub.
 */
class FakeElement {
    children: FakeElement[] = [];
    parentNode: FakeElement | undefined;
    className = "";
    textContent = "";
    innerHTML = "";
    attributes: Record<string, string> = {};
    dataset: Record<string, string> = {};
    constructor(public tag: string) {}
    get classList() {
        return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
    }
    setAttribute(name: string, value: string) {
        this.attributes[name] = value;
    }
    appendChild(node: FakeElement) {
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    removeChild(node: FakeElement) {
        this.children = this.children.filter(child => child !== node);
        node.parentNode = undefined;
        return node;
    }
    querySelector(selector: string): FakeElement | null {
        if (selector === `.group-heading[data-group="unknown"]`) {
            return this.children.find(c => c.classList.contains("group-heading") && c.attributes["data-group"] === "unknown") ?? null;
        }
        return this.children.find(c => c.classList.contains(selector.replace(".", ""))) ?? null;
    }
}

function fakeCard(id: string, dataset: Record<string, string>): FakeElement {
    const card = new FakeElement("a");
    card.className = "card";
    card.dataset = { game: id, ...dataset };
    for (const cls of ["badge", "card-countdown", "last-checked"]) {
        const child = new FakeElement("span");
        child.className = cls;
        card.appendChild(child);
    }
    return card;
}

function fakeGrid(groups: Array<[string, FakeElement[]]>): FakeElement {
    const grid = new FakeElement("div");
    for (const [group, cards] of groups) {
        const heading = new FakeElement("h2");
        heading.className = "group-heading";
        heading.setAttribute("data-group", group);
        heading.textContent = GROUP_HEADINGS[group as keyof typeof GROUP_HEADINGS];
        grid.appendChild(heading);
        for (const card of cards) grid.appendChild(card);
    }
    return grid;
}

/** What the page looks like now: headings and the cards under them, in order. */
function layout(grid: FakeElement): string[] {
    return grid.children.map(node => (node.classList.contains("group-heading") ? `# ${node.textContent}` : node.dataset.game));
}

test("a card that expires while the page is open moves to the group it now belongs in", () => {
    const app = loadApp();
    const expired = { nextUtc: "2026-06-06T00:00:00.000Z", type: "next-season", precision: "exact", status: "stale", unanswered: "" };
    const ahead = { nextUtc: new Date(Date.now() + 40 * 86_400_000).toISOString(), type: "next-patch", precision: "exact", status: "fresh", unanswered: "" };

    const fortnite = fakeCard("fortnite", expired);
    const lol = fakeCard("lol", ahead);
    const cs2 = fakeCard("cs2", { nextUtc: "2026-09-09T22:51:08.000Z", type: "last-update", precision: "exact", status: "fresh", unanswered: "" });
    const grid = fakeGrid([["upcoming", [fortnite, lol]], ["recent", [cs2]]]);
    app.document = { querySelectorAll: () => grid.children.filter(c => c.classList.contains("card")), createElement: (tag: string) => new FakeElement(tag) };

    app.updateHomepageCountdowns();

    assert.deepEqual(layout(grid), [
        `# ${GROUP_HEADINGS.upcoming}`, "lol",
        `# ${GROUP_HEADINGS.recent}`, "cs2",
        `# ${GROUP_HEADINGS.unknown}`, "fortnite"
    ], "the expired card left 'next up' and the heading it needed was created");
    assert.equal(fortnite.querySelector(".badge")!.textContent, "NO DATE");
});

test("a heading left with no cards beneath it is removed, not left hanging", () => {
    const app = loadApp();
    const expired = { nextUtc: "2026-06-06T00:00:00.000Z", type: "next-season", precision: "exact", status: "stale", unanswered: "" };
    const fortnite = fakeCard("fortnite", expired);
    const grid = fakeGrid([["upcoming", [fortnite]], ["unknown", []]]);
    app.document = { querySelectorAll: () => grid.children.filter(c => c.classList.contains("card")), createElement: (tag: string) => new FakeElement(tag) };

    app.updateHomepageCountdowns();

    assert.deepEqual(layout(grid), [`# ${GROUP_HEADINGS.unknown}`, "fortnite"], "the emptied 'next up' heading is gone");
});

test("the browser badges a card exactly as the build did", () => {
    const app = loadApp();
    const far = 400 * 86_400_000;
    // Far from now in both directions, so the comparison cannot depend on when the suite runs.
    const cases: Array<[string, TrackerData]> = [
        ["upcoming, fresh", data({ type: "next-patch", nextEventUtc: new Date(Date.now() + far).toISOString(), precision: "day" })],
        ["upcoming, unreachable source", data({ type: "next-patch", status: "stale", nextEventUtc: new Date(Date.now() + far).toISOString(), precision: "day" })],
        ["last update, fresh", data({ type: "last-update", nextEventUtc: new Date(Date.now() - far).toISOString(), precision: "exact" })],
        ["last update, unreachable source", data({ type: "last-update", status: "stale", nextEventUtc: new Date(Date.now() - far).toISOString(), precision: "exact" })],
        ["expired question", data({ type: "next-season", status: "stale", nextEventUtc: new Date(Date.now() - far).toISOString() })],
        ["nothing published", data({ status: "unavailable" })]
    ];

    for (const [name, fixture] of cases) {
        const els: Record<string, { textContent: string; innerHTML: string; className: string }> = {
            ".badge": { textContent: "", innerHTML: "", className: "" },
            ".card-countdown": { textContent: "", innerHTML: "", className: "" },
            ".last-checked": { textContent: "", innerHTML: "", className: "" }
        };
        const card = { dataset: {} as Record<string, string>, querySelector: (sel: string) => els[sel] };
        app.renderCard(card, fixture);
        const built = cardValue(fixture, new Date());
        assert.equal(els[".badge"].textContent, built.badgeText, `${name}: badge text`);
        assert.equal(els[".badge"].className, built.badgeClass, `${name}: badge class`);
        assert.equal(card.dataset.unanswered, built.unanswered ? "1" : "", `${name}: unanswered`);
    }
});
