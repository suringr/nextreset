import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SOURCE_STATE, smartFetch } from "../fetch/smart-fetch";
import { extractText, hashText } from "../fetch/text";
import { fakeTransport, fixture } from "./fake-transport";

const ARTICLE_URL = "https://feedback.minecraft.net/hc/en-us/articles/48149564061965-Minecraft-Bedrock-Edition-26-44-45-Hotfix-Changelog";
const RIOT_URL = "https://support-leagueoflegends.riotgames.com/hc/en-us/articles/360018987893-League-of-Legends-Patch-Schedule";
const now = new Date("2026-09-14T12:00:00Z");

test("text extraction is deterministic, strips scripts and prefers substantial main content", () => {
    const html = fixture("minecraft-article.html");
    const a = extractText(html);
    const b = extractText(html);
    assert.deepEqual(a, b);
    assert.equal(hashText(a.text), hashText(b.text));
    assert.match(a.title, /Minecraft: Bedrock Edition 26\.44\/45 Hotfix Changelog/);
    assert.ok(!/function\s*\(/.test(a.text), "script contents must not leak into text");
    assert.ok(a.wordCount >= 120);
    assert.ok(a.bodyWordCount >= a.wordCount);

    const mainWords = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
    const withMain = extractText(`<html><body><nav>Home About</nav><main><p>${mainWords}</p></main><footer>Footer text here</footer></body></html>`);
    assert.equal(withMain.wordCount, 150);
    assert.ok(withMain.bodyWordCount > 150);
    assert.ok(!withMain.text.includes("Footer"));

    // Compact markup without whitespace between block elements still yields separate words.
    const compact = extractText("<html><body><table><tr><td>Patch</td><td>26.19</td></tr><tr><td>Patch</td><td>26.20</td></tr></table><ul><li>Wednesday</li><li>Thursday</li></ul><p>Line one</p><p>Line two</p><h2>Head</h2><span>inline</span><span>text</span></body></html>");
    assert.equal(compact.text, "Patch 26.19 Patch 26.20 Wednesday Thursday Line one Line two Head inlinetext");
    assert.equal(compact.wordCount, 12);

    // Whitespace and markup changes that do not change visible text keep the same hash.
    const h1 = hashText(extractText("<html><body><p>Patch  26.19 lands\n\non   Wednesday</p></body></html>").text);
    const h2 = hashText(extractText("<html><body><div><p>Patch 26.19 lands on Wednesday</p></div><script>x()</script></body></html>").text);
    assert.equal(h1, h2);
});

test("HTTP 304 short-circuits as unchanged and keeps validators", async () => {
    const transport = fakeTransport({ http: [{ notModified: true, status: 304 }] });
    const previous = { ...EMPTY_SOURCE_STATE, etag: "\"abc\"", lastModified: "Mon, 01 Sep 2026 00:00:00 GMT", textHash: "deadbeef", consecutiveFailures: 2 };
    const result = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, previous, transport, now });

    assert.equal(result.outcome, "unchanged");
    assert.equal(result.document, undefined);
    assert.equal(transport.gets[0].etag, "\"abc\"");
    assert.equal(transport.gets[0].lastModified, "Mon, 01 Sep 2026 00:00:00 GMT");
    assert.equal(result.state.textHash, "deadbeef");
    assert.equal(result.state.consecutiveFailures, 0);
    assert.equal(result.state.lastFetchedAt, now.toISOString());
    assert.deepEqual(result.attempts.map(a => a.code), ["not-modified"]);
});

test("a usable HTTP fetch yields a normalized document and stores validators; the same text later is unchanged", async () => {
    const body = fixture("minecraft-article.html");
    const transport = fakeTransport({ http: [{ body, headers: { "etag": "\"v1\"", "last-modified": "Thu, 14 Aug 2026 17:00:33 GMT", "content-type": "text/html" } }] });

    const first = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, transport, now });
    assert.equal(first.outcome, "usable");
    assert.equal(first.document?.mode, "http");
    assert.equal(first.document?.contentType, "text/html");
    assert.ok(first.document!.text.length > 0);
    assert.equal(first.document!.textHash, hashText(extractText(body).text));
    assert.equal(first.state.etag, "\"v1\"");
    assert.equal(first.state.lastUsableAt, now.toISOString());
    assert.equal(first.state.consecutiveFailures, 0);
    assert.equal(transport.renders.length, 0);

    // Second run, same content (server ignored validators): unchanged by hash, document still available.
    const later = new Date("2026-09-15T12:00:00Z");
    const second = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, previous: first.state, transport, now: later });
    assert.equal(second.outcome, "unchanged");
    assert.ok(second.document);
    assert.equal(second.state.textHash, first.state.textHash);
    assert.equal(second.state.lastUsableAt, later.toISOString());
});

test("a JavaScript shell is rendered and the rendered page is used", async () => {
    const transport = fakeTransport({
        http: [{ body: fixture("riot-support-shell.html") }],
        render: [{ html: fixture("minecraft-article.html") }]
    });
    const result = await smartFetch(RIOT_URL, { expect: { kind: "html" }, transport, now, label: "lol-schedule" });

    assert.equal(result.outcome, "usable");
    assert.equal(result.document?.mode, "browser");
    assert.deepEqual(result.attempts.map(a => [a.mode, a.code]), [["http", "js-shell"], ["browser", "usable"]]);
    assert.equal(transport.renders.length, 1);
    assert.equal(transport.renders[0].label, "lol-schedule");
    assert.equal(result.state.lastMode, "browser");
});

test("a challenge that survives rendering is unusable and increments the failure streak", async () => {
    const transport = fakeTransport({
        http: [{ status: 403, body: fixture("fortnite-http-challenge.html") }],
        render: [{ status: 200, html: fixture("fortnite-rendered-challenge.html") }]
    });
    const previous = { ...EMPTY_SOURCE_STATE, textHash: "old", consecutiveFailures: 2 };
    const result = await smartFetch("https://www.fortnite.com/battle-pass", { expect: { kind: "html" }, previous, transport, now });

    assert.equal(result.outcome, "unusable");
    assert.equal(result.verdict?.code, "challenge");
    assert.deepEqual(result.attempts.map(a => [a.mode, a.code]), [["http", "challenge"], ["browser", "challenge"]]);
    assert.equal(result.state.consecutiveFailures, 3);
    assert.equal(result.state.textHash, "old", "a failed fetch must not discard the last good hash");
    assert.equal(result.state.lastVerdict, "challenge");
    assert.equal(result.state.lastMode, "browser");
});

test("rendering is skipped when it cannot help, is not allowed, or the budget is exhausted", async () => {
    // Redirect to homepage: rendering cannot help, so no render call.
    const redirect = fakeTransport({ http: [{ body: fixture("minecraft-article.html"), finalUrl: "https://feedback.minecraft.net/" }], render: [{ html: fixture("minecraft-article.html") }] });
    const redirected = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, transport: redirect, now });
    assert.equal(redirected.outcome, "unusable");
    assert.equal(redirected.verdict?.code, "redirect");
    assert.equal(redirect.renders.length, 0);

    // JSON never renders even for a shell response.
    const json = fakeTransport({ http: [{ body: fixture("riot-support-shell.html") }], render: [{ html: "{}" }] });
    const jsonResult = await smartFetch("https://x.example/api.json", { expect: { kind: "json" }, transport: json, now });
    assert.equal(jsonResult.outcome, "unusable");
    assert.equal(jsonResult.verdict?.code, "parse-error");
    assert.equal(json.renders.length, 0);

    // Budget exhausted: shell stays unusable, no render attempt.
    const noBudget = fakeTransport({ http: [{ body: fixture("riot-support-shell.html") }], render: [{ html: fixture("minecraft-article.html") }], renderBudget: 0 });
    const budgetResult = await smartFetch(RIOT_URL, { expect: { kind: "html" }, transport: noBudget, now });
    assert.equal(budgetResult.outcome, "unusable");
    assert.equal(budgetResult.verdict?.code, "js-shell");
    assert.equal(noBudget.renders.length, 0);

    // Rendering disabled by the caller.
    const disabled = fakeTransport({ http: [{ body: fixture("riot-support-shell.html") }], render: [{ html: fixture("minecraft-article.html") }] });
    const disabledResult = await smartFetch(RIOT_URL, { expect: { kind: "html" }, allowRender: false, transport: disabled, now });
    assert.equal(disabledResult.outcome, "unusable");
    assert.equal(disabled.renders.length, 0);
});

test("transport errors are reported without touching stored validators", async () => {
    const transport = fakeTransport({ http: [{ error: "ECONNRESET" }] });
    const previous = { ...EMPTY_SOURCE_STATE, etag: "\"keep\"", textHash: "keep", consecutiveFailures: 0 };
    const result = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, previous, transport, now });
    assert.equal(result.outcome, "unusable");
    assert.equal(result.error, "ECONNRESET");
    assert.equal(result.state.etag, "\"keep\"");
    assert.equal(result.state.textHash, "keep");
    assert.equal(result.state.consecutiveFailures, 1);

    const renderFails = fakeTransport({ http: [{ body: fixture("riot-support-shell.html") }], render: [{ html: "", error: "browser crashed" }] });
    const rendered = await smartFetch(RIOT_URL, { expect: { kind: "html" }, transport: renderFails, now });
    assert.equal(rendered.outcome, "unusable");
    assert.equal(rendered.error, "browser crashed");
    assert.equal(rendered.verdict?.code, "js-shell");
});

test("transient transport errors and 5xx responses are retried a bounded number of times", async () => {
    const body = fixture("minecraft-article.html");
    const flaky = fakeTransport({ http: [{ error: "ETIMEDOUT" }, { status: 503, body: "<html><body>down</body></html>" }, { body }] });
    const result = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, transport: flaky, now, retryDelayMs: 0 });
    assert.equal(result.outcome, "usable");
    assert.equal(flaky.gets.length, 3);
    assert.deepEqual(result.attempts.map(a => a.code), ["error", "http-error", "usable"]);
    assert.equal(result.state.consecutiveFailures, 0);

    const alwaysDown = fakeTransport({ http: [{ status: 502, body: "<html><body>bad gateway</body></html>" }] });
    const down = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, transport: alwaysDown, now, retryDelayMs: 0 });
    assert.equal(down.outcome, "unusable");
    assert.equal(alwaysDown.gets.length, 3, "default is two retries after the first attempt");
    assert.equal(down.verdict?.code, "http-error");
    assert.equal(down.state.consecutiveFailures, 1, "one failed fetch, not one per attempt");

    const noRetry = fakeTransport({ http: [{ error: "ECONNRESET" }, { body }] });
    const single = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, transport: noRetry, now, retries: 0 });
    assert.equal(single.outcome, "unusable");
    assert.equal(noRetry.gets.length, 1);

    // 4xx is not retried: the answer is definitive.
    const forbidden = fakeTransport({ http: [{ status: 403, body: "<html><body>Forbidden</body></html>" }, { body }] });
    const notRetried = await smartFetch(ARTICLE_URL, { expect: { kind: "html" }, allowRender: false, transport: forbidden, now, retryDelayMs: 0 });
    assert.equal(notRetried.outcome, "unusable");
    assert.equal(forbidden.gets.length, 1);
});

test("structured sources: JSON body becomes the document text, hashed", async () => {
    const body = fixture("roblox-hostedstatus.json");
    const transport = fakeTransport({ http: [{ body, headers: { "content-type": "application/json" } }] });
    const result = await smartFetch("http://hostedstatus.com/1.0/status/59db90dbcdeb2f04dadcf16d", { expect: { kind: "json" }, transport, now });
    assert.equal(result.outcome, "usable");
    assert.equal(result.document?.body, body);
    assert.equal(result.document?.title, "");
    assert.ok(result.document!.text.includes("status_overall"));
    assert.equal(result.document!.textHash.length, 64);
});
