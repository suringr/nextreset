/**
 * AiProvider: the only seam through which the pipeline talks to a language model.
 *
 * One operation, `generateJson`: a system instruction, a prompt, and a JSON
 * schema the answer must satisfy. Providers are configured from the environment
 * (AI_PROVIDER, AI_MODEL, GEMINI_API_KEY) and the API key never leaves this
 * module except inside the SDK call. Every response is validated and grounded
 * by deterministic code (see extraction.ts); nothing a model returns is ever
 * published directly.
 */

export interface AiJsonRequest {
    /** Short tag used in usage accounting and logs (never sent to the model). */
    label: string;
    system: string;
    prompt: string;
    /** Standard JSON Schema describing the required response object. */
    schema: Record<string, unknown>;
    maxOutputTokens?: number;
}

export interface AiUsage {
    inputTokens: number;
    outputTokens: number;
    thoughtTokens?: number;
}

export interface AiJsonResponse {
    /** Parsed JSON; callers validate the shape before trusting a single field. */
    data: unknown;
    usage: AiUsage;
    /** Model version the provider reports for this call. */
    model: string;
    /** Retries the provider made inside this call; `usage` includes the tokens of every billed attempt. */
    retries?: number;
}

export interface AiProvider {
    readonly name: string;
    readonly model: string;
    generateJson(request: AiJsonRequest): Promise<AiJsonResponse>;
}

export class AiError extends Error {
    /** Tokens of answers that came back but were unusable (they are billed), when the provider knows them. */
    usage?: AiUsage;
    /** Retries the provider made before giving up. */
    retries?: number;

    constructor(message: string, public readonly retryable: boolean, public readonly status?: number) {
        super(message);
        this.name = "AiError";
    }
}

export type AiProviderName = "gemini" | "mock";

export interface AiConfig {
    provider: AiProviderName;
    model: string;
    apiKey?: string;
    /** Gemini thinking budget in tokens (AI_THINKING_BUDGET); default 0 = thinking off. */
    thinkingBudget?: number;
}

export const DEFAULT_AI_MODEL = "gemini-3.5-flash";

/**
 * Reads AI_PROVIDER (default gemini), AI_MODEL (default gemini-3.5-flash),
 * AI_THINKING_BUDGET (default 0) and GEMINI_API_KEY. Returns undefined when the
 * gemini provider is selected but no key is present, so callers can run without
 * AI instead of failing at call time.
 */
export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | undefined {
    const provider = (env.AI_PROVIDER || "gemini").trim().toLowerCase();
    const model = (env.AI_MODEL || DEFAULT_AI_MODEL).trim();
    const budgetRaw = env.AI_THINKING_BUDGET?.trim();
    const thinkingBudget = budgetRaw === undefined || budgetRaw === "" ? 0 : Number(budgetRaw);
    if (!Number.isInteger(thinkingBudget) || thinkingBudget < 0) throw new AiError(`AI_THINKING_BUDGET must be a non-negative integer, got ${JSON.stringify(budgetRaw)}`, false);
    if (provider === "mock") return { provider: "mock", model, thinkingBudget };
    if (provider !== "gemini") throw new AiError(`Unsupported AI_PROVIDER ${JSON.stringify(provider)} (expected gemini or mock)`, false);
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) return undefined;
    return { provider: "gemini", model, apiKey, thinkingBudget };
}

/** Replaces every occurrence of a secret in a string (error messages, URLs). */
export function redactSecret(text: string, secret: string | undefined): string {
    if (!secret || secret.length < 8) return text;
    return text.split(secret).join("[redacted]");
}

export interface UsageByLabel {
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
}

/** Accumulates calls and tokens per run so cost can be reported without logging prompts. */
export class AiUsageTracker {
    calls = 0;
    failures = 0;
    inputTokens = 0;
    outputTokens = 0;
    thoughtTokens = 0;
    readonly byLabel: Record<string, UsageByLabel> = {};

    private bucket(label: string): UsageByLabel {
        return (this.byLabel[label] ??= { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0 });
    }

    record(label: string, usage: AiUsage): void {
        const b = this.bucket(label);
        b.calls++;
        b.inputTokens += usage.inputTokens;
        b.outputTokens += usage.outputTokens;
        b.thoughtTokens += usage.thoughtTokens ?? 0;
        this.calls++;
        this.inputTokens += usage.inputTokens;
        this.outputTokens += usage.outputTokens;
        this.thoughtTokens += usage.thoughtTokens ?? 0;
    }

    recordFailure(label: string): void {
        this.bucket(label).failures++;
        this.failures++;
    }

    summary(): { calls: number; failures: number; inputTokens: number; outputTokens: number; thoughtTokens: number; byLabel: Record<string, UsageByLabel> } {
        return { calls: this.calls, failures: this.failures, inputTokens: this.inputTokens, outputTokens: this.outputTokens, thoughtTokens: this.thoughtTokens, byLabel: { ...this.byLabel } };
    }
}

/** Decorates a provider with usage accounting. */
export class TrackedAiProvider implements AiProvider {
    constructor(private readonly inner: AiProvider, readonly tracker: AiUsageTracker) { }
    get name(): string { return this.inner.name; }
    get model(): string { return this.inner.model; }

    async generateJson(request: AiJsonRequest): Promise<AiJsonResponse> {
        try {
            const response = await this.inner.generateJson(request);
            this.tracker.record(request.label, response.usage);
            return response;
        } catch (error) {
            this.tracker.recordFailure(request.label);
            throw error;
        }
    }
}

/** Builds the configured provider. Gemini's SDK is loaded lazily on first call. */
export async function createAiProvider(config: AiConfig): Promise<AiProvider> {
    if (config.provider === "gemini") {
        if (!config.apiKey) throw new AiError("GEMINI_API_KEY is required for the gemini provider", false);
        const { GeminiProvider } = await import("./gemini");
        return new GeminiProvider({ apiKey: config.apiKey, model: config.model, thinkingBudget: config.thinkingBudget });
    }
    const { MockAiProvider } = await import("./mock");
    return new MockAiProvider(config.model, () => {
        throw new AiError("mock provider has no scripted response", false);
    });
}
