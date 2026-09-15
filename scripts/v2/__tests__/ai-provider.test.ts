import test from "node:test";
import assert from "node:assert/strict";
import { GeminiClientLike, GeminiProvider, GeminiResponseLike } from "../ai/gemini";
import { MockAiProvider, scriptedResponder } from "../ai/mock";
import { AiError, AiUsageTracker, DEFAULT_AI_MODEL, TrackedAiProvider, createAiProvider, readAiConfig, redactSecret } from "../ai/provider";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const REQUEST = { label: "extract", system: "sys", prompt: "hello", schema: SCHEMA };

function fakeClient(responses: Array<GeminiResponseLike | Error>): GeminiClientLike & { calls: Array<{ model: string; contents: string; config?: Record<string, unknown> }> } {
    let i = 0;
    const client = {
        calls: [] as Array<{ model: string; contents: string; config?: Record<string, unknown> }>,
        models: {
            async generateContent(params: { model: string; contents: string; config?: Record<string, unknown> }) {
                client.calls.push(params);
                const next = responses[Math.min(i++, responses.length - 1)];
                if (next instanceof Error) throw next;
                return next;
            }
        }
    };
    return client;
}

test("readAiConfig reads provider, model and key from the environment", () => {
    assert.equal(readAiConfig({}), undefined, "gemini without a key is 'AI not configured'");
    assert.deepEqual(readAiConfig({ GEMINI_API_KEY: "k-123456789" }), { provider: "gemini", model: DEFAULT_AI_MODEL, apiKey: "k-123456789" });
    assert.deepEqual(readAiConfig({ AI_PROVIDER: "gemini", AI_MODEL: "gemini-x", GEMINI_API_KEY: " k-123456789 " }), { provider: "gemini", model: "gemini-x", apiKey: "k-123456789" });
    assert.deepEqual(readAiConfig({ AI_PROVIDER: "mock" }), { provider: "mock", model: DEFAULT_AI_MODEL });
    assert.throws(() => readAiConfig({ AI_PROVIDER: "openai", GEMINI_API_KEY: "x" }), AiError);
    assert.equal(DEFAULT_AI_MODEL, "gemini-3.5-flash");
});

test("redactSecret removes the key from any text", () => {
    assert.equal(redactSecret("error at https://x?key=AIzaSecretKey123 again AIzaSecretKey123", "AIzaSecretKey123"), "error at https://x?key=[redacted] again [redacted]");
    assert.equal(redactSecret("nothing", undefined), "nothing");
    assert.equal(redactSecret("short key 123", "123"), "short key 123", "very short strings are not treated as secrets");
});

test("usage tracking accumulates per label and counts failures", async () => {
    const tracker = new AiUsageTracker();
    const inner = new MockAiProvider("m", scriptedResponder({ classify: { ok: true }, extract: { ok: true } }), { inputTokens: 100, outputTokens: 10, thoughtTokens: 5 });
    const tracked = new TrackedAiProvider(inner, tracker);
    await tracked.generateJson({ ...REQUEST, label: "classify" });
    await tracked.generateJson({ ...REQUEST, label: "extract" });
    await tracked.generateJson({ ...REQUEST, label: "extract" });
    await assert.rejects(() => tracked.generateJson({ ...REQUEST, label: "unknown" }), AiError);
    const s = tracker.summary();
    assert.equal(s.calls, 3);
    assert.equal(s.failures, 1);
    assert.equal(s.inputTokens, 300);
    assert.equal(s.outputTokens, 30);
    assert.equal(s.thoughtTokens, 15);
    assert.deepEqual(s.byLabel.extract, { calls: 2, failures: 0, inputTokens: 200, outputTokens: 20, thoughtTokens: 10 });
    assert.deepEqual(s.byLabel.unknown, { calls: 0, failures: 1, inputTokens: 0, outputTokens: 0, thoughtTokens: 0 });
    assert.equal(tracked.model, "m");
});

test("GeminiProvider sends structured-output config and parses text plus usage", async () => {
    const client = fakeClient([{ text: "{\"ok\":true}", modelVersion: "gemini-3.5-flash-001", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 12, thoughtsTokenCount: 7 } }]);
    const provider = new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "gemini-3.5-flash", client, retryDelayMs: 0 });
    const response = await provider.generateJson({ ...REQUEST, maxOutputTokens: 256 });
    assert.deepEqual(response, { data: { ok: true }, usage: { inputTokens: 321, outputTokens: 12, thoughtTokens: 7 }, model: "gemini-3.5-flash-001" });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].model, "gemini-3.5-flash");
    assert.equal(client.calls[0].contents, "hello");
    assert.equal(client.calls[0].config?.systemInstruction, "sys");
    assert.equal(client.calls[0].config?.temperature, 0);
    assert.equal(client.calls[0].config?.maxOutputTokens, 256);
    assert.equal(client.calls[0].config?.responseMimeType, "application/json");
    assert.deepEqual(client.calls[0].config?.responseJsonSchema, SCHEMA);
});

test("GeminiProvider retries transient failures, not client errors, and never leaks the key", async () => {
    const transient = Object.assign(new Error("503 Service Unavailable for key AIzaSecretKey123"), { status: 503 });
    const ok: GeminiResponseLike = { text: "{\"ok\":true}", candidates: [{ finishReason: "STOP" }] };
    const client = fakeClient([transient, ok]);
    const provider = new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "m", client, retryDelayMs: 0 });
    const response = await provider.generateJson(REQUEST);
    assert.deepEqual(response.data, { ok: true });
    assert.equal(client.calls.length, 2);
    assert.deepEqual(response.usage, { inputTokens: 0, outputTokens: 0, thoughtTokens: undefined });

    const bad = Object.assign(new Error("400 invalid schema AIzaSecretKey123"), { status: 400 });
    const failing = new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "m", client: fakeClient([bad, ok]), retryDelayMs: 0 });
    await assert.rejects(() => failing.generateJson(REQUEST), (e: unknown) => e instanceof AiError && e.retryable === false && e.status === 400 && !e.message.includes("AIzaSecretKey123") && e.message.includes("[redacted]"));

    const alwaysDown = fakeClient([Object.assign(new Error("502"), { status: 502 })]);
    const exhausted = new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "m", client: alwaysDown, retryDelayMs: 0, maxRetries: 2 });
    await assert.rejects(() => exhausted.generateJson(REQUEST), (e: unknown) => e instanceof AiError && e.retryable === true);
    assert.equal(alwaysDown.calls.length, 3);
});

test("GeminiProvider rejects truncated, blocked, empty and non-JSON answers", async () => {
    const make = (r: GeminiResponseLike) => new GeminiProvider({ apiKey: "AIzaSecretKey123", model: "m", client: fakeClient([r]), retryDelayMs: 0, maxRetries: 0 });
    await assert.rejects(() => make({ text: "{\"ok\":", candidates: [{ finishReason: "MAX_TOKENS" }] }).generateJson(REQUEST), /MAX_TOKENS/);
    await assert.rejects(() => make({ promptFeedback: { blockReason: "SAFETY" } }).generateJson(REQUEST), /blocked/);
    await assert.rejects(() => make({ text: "", candidates: [{ finishReason: "STOP" }] }).generateJson(REQUEST), /empty/);
    await assert.rejects(() => make({ text: "not json", candidates: [{ finishReason: "STOP" }] }).generateJson(REQUEST), /not valid JSON/);
    assert.throws(() => new GeminiProvider({ apiKey: "", model: "m" }), AiError);
});

test("createAiProvider builds the mock provider and refuses gemini without a key", async () => {
    const mock = await createAiProvider({ provider: "mock", model: "m" });
    assert.equal(mock.name, "mock");
    await assert.rejects(() => mock.generateJson(REQUEST), /no scripted response/);
    await assert.rejects(() => createAiProvider({ provider: "gemini", model: "m" }), /GEMINI_API_KEY/);
});
