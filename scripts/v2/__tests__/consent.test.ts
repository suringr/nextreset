/**
 * Consent, and whether it arrives in time to matter.
 *
 * The site loaded Google Analytics and the AdSense library with no consent signal of any kind. Google's
 * own CMP, configured account-side, shows the European regulations message and issues an update — but
 * an update only helps a tag that was waiting for it. Without a declared default, GA4 begins measuring
 * the moment the page opens, and a choice made afterwards is too late for the pageview that prompted it.
 *
 * So the ordering is the thing these tests protect, not the presence of a snippet. A consent block that
 * runs after the tag it is meant to gate is worse than none, because it looks like compliance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.resolve(__dirname, "..", "..", "..", "public");

function pages(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) out.push(path.relative(PUBLIC, full).split(path.sep).join("/"));
        }
    };
    walk(PUBLIC);
    return out.sort();
}

const read = (page: string) => fs.readFileSync(path.join(PUBLIC, page), "utf8");

/** Pages that load a Google tag, which are the only ones with anything to gate. */
const measured = () => pages().filter(page => /googletagmanager\.com\/gtag\/js|adsbygoogle\.js/.test(read(page)));

test("every page that loads a Google tag declares its consent defaults first", () => {
    const checked = measured();
    assert.ok(checked.length > 0, "no page loads a Google tag — this suite is checking nothing");
    for (const page of checked) {
        const html = read(page);
        const declared = html.indexOf("gtag('consent', 'default'");
        assert.ok(declared >= 0, `${page} loads a Google tag and declares no consent default`);

        // Before the loader and before the config call. Both matter: the loader starts fetching, and
        // the config call is what begins measurement.
        for (const after of ["googletagmanager.com/gtag/js", "pagead2.googlesyndication.com", "gtag('config'"]) {
            const at = html.indexOf(after);
            if (at < 0) continue;
            assert.ok(declared < at, `${page} declares consent after ${after}, which is too late to gate it`);
        }
    }
});

test("the defaults deny every storage type Consent Mode v2 defines", () => {
    // Denying ad_storage alone was enough before 2024. ad_user_data and ad_personalization are the two
    // v2 added, and omitting either leaves a signal ungated while looking complete.
    for (const page of measured()) {
        const html = read(page);
        const block = html.slice(html.indexOf("gtag('consent', 'default'"));
        for (const signal of ["ad_storage", "ad_user_data", "ad_personalization", "analytics_storage"]) {
            assert.match(block.slice(0, 600), new RegExp(`${signal}:\\s*'denied'`), `${page} does not deny ${signal} by default`);
        }
    }
});

test("the denial is scoped to where prior consent is required", () => {
    // Denying everywhere would switch analytics off worldwide, since the consent message is only shown
    // where Google's CMP is configured to show it — the defaults would never be updated anywhere else.
    // The region list is the EEA plus the UK and Switzerland.
    const EEA = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
        "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"];
    for (const page of measured()) {
        const html = read(page);
        const block = html.slice(html.indexOf("gtag('consent', 'default'"), html.indexOf("gtag('consent', 'default'") + 900);
        for (const country of [...EEA, "GB", "CH"]) {
            assert.match(block, new RegExp(`'${country}'`), `${page} does not scope its consent default to ${country}`);
        }
        assert.match(block, /wait_for_update:\s*\d+/, `${page} does not wait for the consent message to answer`);
    }
});

test("a page with no Google tag carries no consent block", () => {
    // Nothing to gate, so nothing to declare. 404.html is the case today.
    const unmeasured = pages().filter(page => !measured().includes(page));
    for (const page of unmeasured) {
        assert.ok(!read(page).includes("gtag('consent'"),
            `${page} declares consent defaults but loads no Google tag`);
    }
});

test("the privacy policy describes the defaults the pages actually declare", () => {
    // The policy is a factual claim about the code. The two have been wrong about each other before.
    const privacy = read("privacy/index.html");
    assert.match(privacy, /consent defaults before any Google tag loads/);
    assert.match(privacy, /denied/);
    assert.match(privacy, /European Economic Area, the United Kingdom and Switzerland/);
});
