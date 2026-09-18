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
import * as cheerio from "cheerio";
import { AuthoredCard, GROUP_HEADINGS, cardBlocks, cardValue, nextDrop, readCard, renderHomeHtml, renderNextDropHtml } from "../../render-home";

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

/** The card blocks of a rendered page, in order — found the way the build finds them. */
function cardsOf(html: string): string[] {
    return cardBlocks(html).map(found => found.block);
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
    // Outside the cards region: inside it, the renderer owns every node and stray content stops the
    // build rather than being silently deleted (see "content that would be swallowed" below).
    const withLink = HOME.replace(`<section class="section" id="all-games">`, `<a href="/about/" class="card-link">About</a><section class="section" id="all-games">`);
    assert.ok(renderHomeHtml(withLink, read, NOW).html.includes(`<a href="/about/" class="card-link">About</a>`));
});

test("a card keeps everything it was authored with", () => {
    const decorated = HOME
        .replace(`class="card" id="card-lol"`, `class="card featured" id="card-lol" aria-label="League of Legends patch schedule"`);
    const lol = cardsOf(renderHomeHtml(decorated, read, NOW).html).find(c => c.includes(`id="card-lol"`))!;
    assert.ok(lol.includes(`class="card featured"`), "a modifier class survives the rebuild");
    assert.ok(lol.includes(`aria-label="League of Legends patch schedule"`), "and so does anything else the author put there");
    assert.ok(lol.includes(`data-state="live"`), "while the attributes the build owns are the build's");
});

test("an instant the pipeline has rejected is not left in the page for the updater to find", () => {
    const app = loadApp();
    // Published, but with the confidence the pipeline uses to say it no longer stands behind the value.
    const rejected = data({ game: "lol", type: "next-patch", confidence: "none", precision: "exact", nextEventUtc: new Date(Date.now() + 40 * 86_400_000).toISOString() });
    const built = cardValue(rejected, NOW);
    assert.equal(built.value, "Data unavailable");
    assert.deepEqual(built.dataset, { nextUtc: "", precision: "", status: "" }, "the rejected instant is not carried into the page");

    const html = renderHomeHtml(HOME, (g, t) => (g === "lol" ? rejected : read(g, t)), NOW).html;
    const lol = cardsOf(html).find(c => c.includes(`id="card-lol"`))!;
    assert.ok(lol.includes(`data-next-utc=""`));

    // The browser must not reintroduce it, and the updater must not count down to it.
    const { card, els } = stubCard({ game: "lol", type: "next-patch", nextUtc: "", precision: "", status: "", unanswered: "" });
    app.renderCard(card, rejected);
    assert.equal(card.dataset.nextUtc, "", "hydration stores no instant either");
    assert.equal(els[".card-countdown"].textContent, "Data unavailable");

    app.document = { querySelectorAll: () => [card] };
    app.updateHomepageCountdowns();
    assert.equal(els[".card-countdown"].textContent, "Data unavailable", "and a minute later it still says so");
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
    const published = stubCard({ game: "lol", type: "next-patch", state: "live", nextUtc: "2026-09-23T00:00:00.000Z", precision: "day", status: "fresh", checkedUtc: "2026-09-16T11:00:00.000Z", unanswered: "" });
    // A card the build rendered as unavailable has no instant, but it does have a checked time: that is
    // build-rendered content too, and a failed refresh must not replace it with "--".
    const unavailable = stubCard({ game: "pubg", type: "last-patch", state: "unavailable", nextUtc: "", precision: "", status: "", checkedUtc: "2026-09-16T11:00:00.000Z", unanswered: "" });
    unavailable.els[".last-checked"].textContent = "Checked September 16, 2026 at 11:00 UTC";
    const nothingPublished = stubCard({ game: "fortnite", type: "next-season", state: "loading", nextUtc: "", precision: "", status: "", checkedUtc: "", unanswered: "" });
    const cards = [published.card, unavailable.card, nothingPublished.card];
    app.document = { getElementById: (id: string) => (id === "game-grid" ? { querySelectorAll: () => cards } : null) };
    app.fetchGameData = async () => {
        throw new Error("offline");
    };

    await app.initHomepage();

    assert.equal(published.els[".card-countdown"].textContent, "", "the rendered date is left exactly as it was");
    assert.equal(published.card.dataset.nextUtc, "2026-09-23T00:00:00.000Z", "and the card still knows its date");
    assert.equal(unavailable.els[".last-checked"].textContent, "Checked September 16, 2026 at 11:00 UTC", "an unavailable card keeps the time it was checked");
    assert.equal(nothingPublished.els[".card-countdown"].textContent, "Data unavailable", "a card the build never reached still says so");
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
    getAttribute(name: string): string | null {
        return name in this.attributes ? this.attributes[name] : null;
    }
    appendChild(node: FakeElement) {
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    insertBefore(node: FakeElement, before: FakeElement) {
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.children.splice(this.children.indexOf(before), 0, node);
        return node;
    }
    removeChild(node: FakeElement) {
        this.children = this.children.filter(child => child !== node);
        node.parentNode = undefined;
        return node;
    }
    /** Descendants, not just children: a card's title now sits one level further down, inside its slot. */
    querySelector(selector: string): FakeElement | null {
        if (selector === `.group-heading[data-group="unknown"]`) {
            return this.children.find(c => c.classList.contains("group-heading") && c.attributes["data-group"] === "unknown") ?? null;
        }
        const wanted = selector.replace(".", "");
        for (const child of this.children) {
            if (child.classList.contains(wanted)) return child;
            const deeper = child.querySelector(selector);
            if (deeper) return deeper;
        }
        return null;
    }
    /** The nearest ancestor matching the selector, as the real DOM answers it. */
    closest(selector: string): FakeElement | null {
        const wanted = selector.replace(".", "");
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        let node: FakeElement | undefined = this;
        while (node) {
            if (node.classList.contains(wanted)) return node;
            node = node.parentNode;
        }
        return null;
    }
}

/**
 * The slot the build wraps every card in, holding the card and its track control side by side.
 *
 * The fake carries it because the real page does: regrouping moves the slot, not the card, and a fake
 * that skipped the wrapper would let a broken regrouping pass.
 */
function fakeSlot(card: FakeElement): FakeElement {
    const slot = new FakeElement("div");
    slot.className = "card-slot";
    slot.dataset = { game: card.dataset.game };
    slot.appendChild(card);
    return slot;
}

function fakeCard(id: string, dataset: Record<string, string>, title = id): FakeElement {
    const card = new FakeElement("a");
    card.className = "card";
    card.dataset = { game: id, ...dataset };
    for (const cls of ["badge", "card-countdown", "last-checked", "card-title"]) {
        const child = new FakeElement("span");
        child.className = cls;
        if (cls === "card-title") child.textContent = title;
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
        for (const card of cards) grid.appendChild(fakeSlot(card));
    }
    return grid;
}

/** The cards a page holds, as `document.querySelectorAll('.card[data-game]')` finds them: inside slots. */
function cardsIn(grid: FakeElement): FakeElement[] {
    return grid.children
        .filter(node => node.classList.contains("card-slot"))
        .map(slot => slot.children.find(child => child.classList.contains("card"))!)
        .filter(Boolean);
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
    app.document = { querySelectorAll: () => cardsIn(grid), createElement: (tag: string) => new FakeElement(tag) };

    app.updateHomepageCountdowns();

    assert.deepEqual(layout(grid), [
        `# ${GROUP_HEADINGS.upcoming}`, "lol",
        `# ${GROUP_HEADINGS.recent}`, "cs2",
        `# ${GROUP_HEADINGS.unknown}`, "fortnite"
    ], "the expired card left 'next up' and the heading it needed was created");
    assert.equal(fortnite.querySelector(".badge")!.textContent, "NO DATE");
});

test("cards that expire one after another still read in the order the group is sorted by", () => {
    const app = loadApp();
    const expired = { type: "next-season", precision: "exact", status: "stale", unanswered: "" };
    const gone = (iso: string) => ({ ...expired, nextUtc: iso });
    // Fortnite is already unanswered; GTA expires first, then Genshin. The group is ordered by name.
    const fortnite = fakeCard("fortnite", { ...gone("2026-06-06T00:00:00.000Z"), unanswered: "1" }, "Fortnite");
    const gta = fakeCard("gta", gone("2026-06-07T00:00:00.000Z"), "GTA Online");
    const genshin = fakeCard("genshin", gone("2026-06-08T00:00:00.000Z"), "Genshin Impact");
    const grid = fakeGrid([["upcoming", [gta, genshin]], ["unknown", [fortnite]]]);
    const cards = [gta, genshin, fortnite];
    app.document = { querySelectorAll: () => cardsIn(grid), createElement: (tag: string) => new FakeElement(tag) };

    // Two cycles, because GTA's deadline passes before Genshin's: they do not expire together.
    app.updateHomepageCountdowns();
    app.updateHomepageCountdowns();

    assert.deepEqual(layout(grid), [`# ${GROUP_HEADINGS.unknown}`, "fortnite", "genshin", "gta"], "not the order they expired in");
    assert.equal(cards.length, 3);
});

test("a page loaded after its deadline moves the card as it renders it", () => {
    const app = loadApp();
    // Built while the date was ahead, opened once it had expired: the card is unanswered from its first
    // paint, so the updater never sees it change and would leave it under "Next up" forever.
    // renderCard reads the real clock, so the fixture is relative: always long expired, whenever it runs.
    const expiredAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const lol = fakeCard("lol", { nextUtc: expiredAt, type: "next-patch", precision: "day", status: "live", unanswered: "" }, "League of Legends");
    const cs2 = fakeCard("cs2", { nextUtc: "2026-09-09T22:51:08.000Z", type: "last-update", precision: "exact", status: "fresh", unanswered: "" }, "Counter-Strike 2");
    const grid = fakeGrid([["upcoming", [lol]], ["recent", [cs2]]]);
    app.document = { createElement: (tag: string) => new FakeElement(tag) };

    app.renderCard(lol, { game: "lol", type: "next-patch", status: "stale", precision: "day", nextEventUtc: expiredAt, confidence: "high", fetched_at_utc: expiredAt });

    assert.equal(lol.querySelector(".badge")!.textContent, "NO DATE");
    assert.deepEqual(layout(grid), [
        `# ${GROUP_HEADINGS.recent}`, "cs2",
        `# ${GROUP_HEADINGS.unknown}`, "lol"
    ], "it moved as it was rendered, and the heading it left is gone");
});

test("a date stays set as a date when the browser rewrites it", () => {
    const app = loadApp();
    const { card, els } = stubCard({ game: "lol", type: "next-patch", state: "live", nextUtc: "", precision: "", status: "", unanswered: "" });
    els[".card-countdown"].className = "card-countdown is-text";

    app.renderCard(card, PUBLISHED["lol.next-patch"]);
    assert.equal(els[".card-countdown"].className, "card-countdown is-text", "a date keeps the styling the build gave it");

    // `renderCard` reads the real clock, so the instant has to be ahead of whenever this runs. Pinning
    // it to a calendar date made this test expire: it passed until 2026-09-17 and failed from the 18th,
    // when the fixture's reset became a past event and the card correctly stopped being a countdown.
    const upcoming = { ...PUBLISHED["gta.weekly-reset"], nextEventUtc: new Date(Date.now() + 3 * 86400000).toISOString() };
    app.renderCard(card, upcoming);
    assert.equal(els[".card-countdown"].className, "card-countdown", "a countdown does not");
});

test("a heading left with no cards beneath it is removed, not left hanging", () => {
    const app = loadApp();
    const expired = { nextUtc: "2026-06-06T00:00:00.000Z", type: "next-season", precision: "exact", status: "stale", unanswered: "" };
    const fortnite = fakeCard("fortnite", expired);
    const grid = fakeGrid([["upcoming", [fortnite]], ["unknown", []]]);
    app.document = { querySelectorAll: () => cardsIn(grid), createElement: (tag: string) => new FakeElement(tag) };

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
        ["nothing published", data({ status: "unavailable" })],
        // A rejected payload that also happens to have expired: unavailable, not unanswered. Asking the
        // second question before the first produced a NO DATE badge above "Data unavailable".
        ["expired and rejected", data({ type: "next-season", confidence: "none", nextEventUtc: new Date(Date.now() - far).toISOString() })],
        ["expired and superseded", data({ type: "next-season", status: "fallback", nextEventUtc: new Date(Date.now() - far).toISOString() })]
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

// === V4: the lead block, the track control and My Games ===

/** The rendered homepage, parsed, so structure can be asked about rather than matched as a string. */
function renderedHome(over: Record<string, TrackerData | undefined> = {}, now = NOW) {
    const read = (game: string, type: string): TrackerData | undefined => {
        const key = `${game}.${type}`;
        return key in over ? over[key] : PUBLISHED[key];
    };
    const html = renderHomeHtml(HOME, read, now).html;
    return { html, $: cheerio.load(html) };
}

test("the lead block is the first card of the upcoming group, and nothing decides it twice", () => {
    const { $ } = renderedHome();
    const drop = $(".drop");
    assert.equal(drop.length, 1);
    // GTA is the soonest upcoming event in the fixture, and the grid must agree, because both come from
    // the same ordering. If they ever disagreed the page would contradict itself in its two most
    // visible places.
    assert.equal(drop.attr("data-game"), "gta");
    assert.equal(drop.attr("data-kind"), "upcoming");
    assert.equal(drop.find(".drop-eyebrow").text(), "Next drop");
    assert.equal($("a.card").first().attr("data-game"), "gta", "the grid leads with the same tracker");
});

test("the lead block publishes a countdown only where the source stated an exact instant", () => {
    // The build writes the absolute instant even when it is exact, because a page built six hours ago
    // would be counting from the wrong moment. app.js turns it into a countdown in the browser.
    const { $ } = renderedHome();
    assert.equal($(".drop").attr("data-precision"), "exact");
    assert.equal($(".drop-value").text(), "September 17, 2026 at 10:00 UTC");
    assert.equal($(".drop-precision").length, 0, "an exact instant does not claim the time is unannounced");
    assert.equal($(".drop-count").length, 0, "the build never writes countdown tiles");
});

test("a day-only lead block stays a date and says the time was not announced", () => {
    const { $ } = renderedHome({
        "gta.weekly-reset": data({ game: "gta", type: "weekly-reset", nextEventUtc: "2026-09-17T00:00:00.000Z", precision: "day" }),
        "genshin.next-banner": data({ game: "genshin", type: "next-banner", nextEventUtc: "2026-09-22T00:00:00.000Z", precision: "day" })
    });
    assert.equal($(".drop").attr("data-game"), "gta");
    assert.equal($(".drop").attr("data-precision"), "day");
    assert.equal($(".drop-value").text(), "September 17, 2026");
    assert.ok($(".drop-value").hasClass("is-date"));
    assert.equal($(".drop-precision").text(), "Time not announced");
    assert.ok(!$(".drop-value").text().includes("00:00"), "midnight is a storage artefact, never a time");
});

test("with nothing upcoming the page leads with the latest verified change, and says so", () => {
    const nothingAhead: Record<string, TrackerData | undefined> = {};
    for (const [key, value] of Object.entries(PUBLISHED)) {
        // Every future-facing tracker loses its answer; the recently-updated ones keep theirs.
        if (value.type?.startsWith("next-") || value.type?.includes("reset")) nothingAhead[key] = undefined;
    }
    const { $ } = renderedHome(nothingAhead);
    const drop = $(".drop");
    assert.equal(drop.attr("data-kind"), "latest");
    assert.equal(drop.find(".drop-eyebrow").text(), "Latest verified change");
    assert.ok(drop.find(".drop-value").text().length > 0, "it still leads with a real value");
    assert.equal($("a.card").length, 12, "and every tracker is still on the page");
});

test("with nothing verified at all the page still says something true", () => {
    const nothing: Record<string, TrackerData | undefined> = {};
    for (const key of Object.keys(PUBLISHED)) nothing[key] = undefined;
    const { $ } = renderedHome(nothing);
    assert.equal($(".drop").length, 1);
    assert.equal($(".drop-game").text(), "Nothing verified right now");
    assert.equal($(".drop-value").length, 0, "no value is invented to fill the space");
    assert.equal($("a.card").length, 12, "and the trackers still say what they know");
});

test("nextDrop prefers upcoming, falls back to recent, and gives up honestly", () => {
    const card = (game: string): AuthoredCard => ({ href: "/" + game + "/x/", id: "card-" + game, game, type: "x", title: game, topic: "t", attributes: {} });
    const entry = (game: string, group: "upcoming" | "recent" | "unknown", at: number) =>
        ({ card: card(game), value: { ...cardValue(undefined, NOW), group, at }, data: undefined });

    assert.equal(nextDrop([entry("a", "recent", 2), entry("b", "upcoming", 5), entry("c", "upcoming", 1)])!.card.game, "c", "soonest upcoming");
    assert.equal(nextDrop([entry("a", "recent", 2), entry("b", "recent", 9)])!.card.game, "b", "newest recent");
    assert.equal(nextDrop([entry("a", "recent", 2), entry("b", "recent", 9)])!.kind, "latest");
    assert.equal(nextDrop([entry("a", "unknown", 0)]), undefined, "nothing verified is nothing to lead with");
    assert.equal(nextDrop([]), undefined);
});

test("the lead block escapes what it is given", () => {
    const hostile = data({ game: "x", type: "next-x", nextEventUtc: "2026-09-20T00:00:00.000Z", precision: "day" });
    const drop = nextDrop([{
        card: { href: "/x/\"><script>", id: "card-x", game: "x\"><script>", type: "t", title: "<img src=x>", topic: "\"", attributes: {} },
        value: cardValue(hostile, NOW),
        data: hostile
    }])!;
    const html = renderNextDropHtml(drop, "\n");
    assert.ok(!html.includes("<script>"), "no markup from data reaches the page");
    assert.ok(html.includes("&lt;img src=x&gt;"));
});

test("the track control is a sibling of the card, never a child of it", () => {
    const { $ } = renderedHome();
    assert.equal($("a.card button").length, 0, "a button inside an anchor is invalid and ambiguous to tap");
    assert.equal($(".card-slot").length, 12);
    for (const slot of $(".card-slot").toArray()) {
        const el = $(slot);
        assert.equal(el.children("a.card").length, 1);
        assert.equal(el.children("button.track").length, 1);
        assert.equal(el.attr("data-game"), el.children("a.card").attr("data-game"));
    }
});

test("the track control ships hidden, because without JavaScript it does nothing", () => {
    const { $ } = renderedHome();
    for (const button of $("button.track").toArray()) {
        assert.equal($(button).attr("hidden") !== undefined, true, "a dead control is worse than no control");
        assert.equal($(button).attr("aria-pressed"), "false");
        assert.ok($(button).find(".track-label").text().length > 0, "and it is named for a screen reader");
    }
});

test("the page carries every tracker exactly once, with one link each", () => {
    const { $ } = renderedHome();
    const games = $("a.card").map((_, el) => $(el).attr("data-game")).get();
    assert.equal(games.length, 12);
    assert.equal(new Set(games).size, 12, "no tracker is rendered twice");
    for (const game of games) {
        assert.equal($('a.card[data-game="' + game + '"]').length, 1, game + " has exactly one card");
    }
});

test("the cards region is the only thing the renderer rewrites", () => {
    const { $ } = renderedHome();
    assert.equal($("#my-games").length, 1, "the My Games shelf is authored and stays");
    assert.equal($("#my-games").attr("hidden") !== undefined, true, "and stays hidden until app.js fills it");
    assert.equal($("#all-games").length, 1);
    assert.ok($(".content-section").length >= 3, "the explainer prose survives");
});

// === Codex review of #49 ===

/** A lead block as the build writes it, with only what initNextDrop reads. */
function fakeDrop(kind: string, nextUtc: string, shown: string) {
    const value = { textContent: shown, className: "drop-value is-date", innerHTML: "" };
    const attrs: Record<string, string> = { "data-next-utc": nextUtc, "data-precision": "exact", "data-kind": kind };
    const drop = {
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        querySelector: (selector: string) => (selector === ".drop-value" ? value : null)
    };
    return { drop, value };
}

function runNextDrop(kind: string, nextUtc: string, shown: string) {
    const app = loadApp();
    const { drop, value } = fakeDrop(kind, nextUtc, shown);
    app.document = { querySelector: (selector: string) => (selector === ".drop[data-next-utc]" ? drop : null) };
    app.initNextDrop();
    return value;
}

test("the latest-change lead keeps its verified value, even when its time is exact", () => {
    // Codex P2 on #49: the fallback lead is the most recent verified change, so its instant is in the
    // past by definition. Treated as a countdown it became "Updating..." the moment the page loaded.
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    const value = runNextDrop("latest", past, "September 16, 2026 at 11:23 UTC");
    assert.equal(value.textContent, "September 16, 2026 at 11:23 UTC");
    assert.notEqual(value.textContent, "Updating...");
});

test("an upcoming exact lead still becomes a live countdown, and a passed one still says so", () => {
    const soon = runNextDrop("upcoming", new Date(Date.now() + 3 * 86400000).toISOString(), "September 22, 2026 at 06:59 UTC");
    assert.equal(soon.className, "drop-value", "an upcoming exact instant is a countdown");
    assert.ok(soon.innerHTML.length > 0, "and the countdown was drawn");
    const gone = runNextDrop("upcoming", new Date(Date.now() - 60000).toISOString(), "September 18, 2026 at 10:00 UTC");
    assert.equal(gone.textContent, "Updating...", "an upcoming drop whose moment passed is waiting for the next refresh");
});

test("a card that went unanswered on the shelf is restored among the unanswered, not under Next up", () => {
    // Codex P2 on #49: an expired tracked card is marked unanswered but left on the shelf by design.
    // Untracked, it went back by its build-time group and sat under "Next up" saying "No official date
    // announced" — and no later pass moved it, because it was already marked.
    const app = loadApp();
    const lol = fakeCard("lol", {}, "League of Legends");
    const gta = fakeCard("gta", {}, "GTA Online");
    const fortnite = fakeCard("fortnite", { unanswered: "1" }, "Fortnite");
    const grid = fakeGrid([["upcoming", [lol, gta]], ["unknown", [fortnite]]]);
    app.markHomePositions(grid);

    const slot = lol.parentNode!;
    const shelf = new FakeElement("div");
    shelf.appendChild(slot);          // tracked
    lol.dataset.unanswered = "1";     // its date passed while it sat on the shelf
    app.restoreToGrid(grid, slot);    // untracked

    assert.deepEqual(layout(grid), [
        `# ${GROUP_HEADINGS.upcoming}`, "gta",
        `# ${GROUP_HEADINGS.unknown}`, "fortnite", "lol"
    ]);
});

test("a card that is still answered goes back exactly where the build had it", () => {
    const app = loadApp();
    const lol = fakeCard("lol", {}, "League of Legends");
    const gta = fakeCard("gta", {}, "GTA Online");
    const grid = fakeGrid([["upcoming", [lol, gta]]]);
    app.markHomePositions(grid);
    const slot = lol.parentNode!;
    new FakeElement("div").appendChild(slot);
    app.restoreToGrid(grid, slot);
    assert.deepEqual(layout(grid), [`# ${GROUP_HEADINGS.upcoming}`, "lol", "gta"]);
});

