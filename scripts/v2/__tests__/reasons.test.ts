/**
 * Public failure wording: a visitor is told what happened, in one sentence, with no internal detail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Event, emptyKnowledge } from "../domain";
import { findGame, findTopic } from "../games";
import { failureKindOfRun } from "../adapters/ai-discovery";
import { FailureKind, PUBLIC_REASONS, failureKindFromFetch, publicReason } from "../reasons";
import { deriveProviderResult } from "../views";

const gtaTopic = findTopic(findGame("gta"), "weekly-reset");
const now = new Date("2026-09-16T12:00:00Z");

function knowledgeWithEvent() {
    const gta = emptyKnowledge("gta", now);
    const event: Event = {
        key: "gta/weekly-reset/2026-09-17", game: "gta", topic: "weekly-reset", kind: "recurring",
        label: "Weekly reset", status: "scheduled", at: "2026-09-17T10:00:00.000Z", precision: "exact",
        timezone: "UTC", firstSeen: "2026-09-01T00:00:00.000Z", lastVerified: "2026-09-15T06:00:00.000Z",
        publishState: "published"
    };
    gta.events.push(event);
    return gta;
}

test("a failed fetch is classified by what actually happened", () => {
    const kind = (input: Parameters<typeof failureKindFromFetch>[0]) => failureKindFromFetch(input);

    // Riot's certificate incident: the request never completed.
    assert.equal(kind({ error: "fetch failed", attempts: [{ status: 0 }] }), "source-unreachable");
    assert.equal(kind({ verdict: { code: "http-error" }, attempts: [{ status: 502 }] }), "source-unreachable");
    assert.equal(kind({ verdict: { code: "empty" }, attempts: [{ status: 503 }] }), "source-unreachable", "a server error is unreachable, whatever the body");

    // Answered, but refused.
    assert.equal(kind({ verdict: { code: "challenge" }, attempts: [{ status: 200 }] }), "source-blocked");
    assert.equal(kind({ verdict: { code: "http-error" }, attempts: [{ status: 403 }] }), "source-blocked");
    assert.equal(kind({ verdict: { code: "http-error" }, attempts: [{ status: 429 }] }), "source-blocked");

    // Reached and read, but unusable. A 404 or 410 was answered by the server: the page is gone, not unreachable.
    assert.equal(kind({ verdict: { code: "http-error" }, attempts: [{ status: 404 }] }), "extraction-failed");
    assert.equal(kind({ verdict: { code: "http-error" }, attempts: [{ status: 410 }] }), "extraction-failed");
    assert.equal(kind({ verdict: { code: "js-shell" }, attempts: [{ status: 200 }] }), "extraction-failed");
    assert.equal(kind({ verdict: { code: "insufficient" }, attempts: [{ status: 200 }] }), "extraction-failed");
    assert.equal(kind({ verdict: { code: "parse-error" }, attempts: [{ status: 200 }] }), "extraction-failed");
});

test("a run reports what actually stopped it", () => {
    const run = (outcomes: string[], fetch?: { mode: "http" | "browser"; status: number; verdict?: string; attempts: number }) =>
        failureKindOfRun({
            knownSources: [], skipped: [], ai: { calls: 0, failures: 0, repairs: 0, retries: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, estimatedCostUsd: 0 },
            attempts: outcomes.map(outcome => ({ url: "https://example.com", via: "config" as const, outcome: outcome as never, elapsedMs: 1, ...(fetch ? { fetch } : {}) }))
        });

    assert.equal(run(["unchanged"]), "no-new-information");
    assert.equal(run(["not-relevant"]), "no-new-information", "the page was read fine and simply does not answer this topic");
    assert.equal(run(["no-facts"]), "extraction-failed", "read, but nothing could be taken from it");
    assert.equal(run(["no-ai"]), "awaiting-verification");
    assert.equal(run(["deferred"]), "awaiting-verification");
    assert.equal(run(["unusable"], { mode: "http", status: 503, verdict: "http-error", attempts: 1 }), "source-unreachable");
    assert.equal(run(["unusable"], { mode: "http", status: 200, verdict: "challenge", attempts: 1 }), "source-blocked");
});

test("every kind has one concise sentence, free of internal detail", () => {
    const kinds: FailureKind[] = ["source-unreachable", "source-blocked", "awaiting-verification", "extraction-failed", "budget-deferred", "no-new-information"];
    for (const kind of kinds) {
        const sentence = PUBLIC_REASONS[kind];
        assert.ok(sentence.length > 0 && sentence.length <= 80, `${kind}: ${sentence}`);
        assert.ok(!/https?:|GEMINI|API_KEY|\$|Error:|undefined|\bat \//.test(sentence), `${kind} leaks internal detail: ${sentence}`);
        assert.equal(publicReason(kind), sentence);
    }
    assert.equal(publicReason(undefined), "The official source could not be checked", "an unrecognised failure stays vague rather than leaking");
});

test("the stale view publishes the public sentence and the kind, not the internal detail", () => {
    const view = deriveProviderResult(gtaTopic, knowledgeWithEvent(), {
        now,
        outcome: { ok: false, reason: "https://support.riotgames.com/...: fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)", kind: "source-unreachable" }
    }) as unknown as Record<string, unknown>;

    assert.equal(view.status, "stale");
    assert.equal(view.reason, "The official source could not be reached");
    assert.equal(view.reason_code, "source-unreachable");
    assert.ok(!JSON.stringify(view).includes("riotgames.com/..."), "the internal detail is not published");
    assert.equal(view.nextEventUtc, "2026-09-17T10:00:00.000Z", "the last verified value is still served");
    assert.equal(view.last_success_at_utc, "2026-09-15T06:00:00.000Z");
});

test("an unreachable source and a page awaiting verification read differently", () => {
    const reason = (kind: FailureKind) => (deriveProviderResult(gtaTopic, knowledgeWithEvent(), { now, outcome: { ok: false, reason: "detail", kind } }) as unknown as Record<string, unknown>).reason;
    assert.notEqual(reason("source-unreachable"), reason("awaiting-verification"));
    assert.equal(reason("awaiting-verification"), "An updated official page is waiting to be verified");
    assert.equal(reason("no-new-information"), "No new information has been published");
    assert.equal(reason("source-blocked"), "The official source refused an automated check");
});

test("an unavailable view explains itself without internal detail", () => {
    const empty = emptyKnowledge("gta", now);
    const view = deriveProviderResult(gtaTopic, empty, { now, outcome: { ok: false, reason: "no official page found by discovery (2 candidates)", kind: "no-new-information" } }) as unknown as Record<string, unknown>;
    assert.equal(view.status, "unavailable");
    assert.equal(view.explanation, "No new information has been published");
    assert.equal(view.reason_code, "no-new-information");

    const first = deriveProviderResult(gtaTopic, empty, { now, outcome: { ok: true } }) as unknown as Record<string, unknown>;
    assert.equal(first.explanation, "No event known for this topic yet");
});
