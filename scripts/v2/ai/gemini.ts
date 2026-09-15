/**
 * Google Gemini implementation of AiProvider (via the official @google/genai SDK).
 *
 * Structured output: `responseMimeType: application/json` plus the request's
 * JSON schema, temperature 0. Transient failures (429, 5xx, network) are
 * retried a bounded number of times. The API key is only ever passed to the
 * SDK client; any error text is redacted before it can reach a log.
 */
import { AiError, AiJsonRequest, AiJsonResponse, AiProvider, AiUsage, redactSecret } from "./provider";

/** The subset of the SDK surface we use, so tests can inject a fake client. */
export interface GeminiClientLike {
    models: {
        generateContent(params: {
            model: string;
            contents: string;
            config?: Record<string, unknown>;
        }): Promise<GeminiResponseLike>;
    };
}

export interface GeminiResponseLike {
    text?: string;
    modelVersion?: string;
    candidates?: Array<{ finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
    };
}

export interface GeminiOptions {
    apiKey: string;
    model: string;
    client?: GeminiClientLike;
    maxRetries?: number;
    retryDelayMs?: number;
    defaultMaxOutputTokens?: number;
    /**
     * Thinking budget in tokens. Thinking tokens count against maxOutputTokens
     * on Gemini, so extraction runs with thinking off (0) by default; a model
     * that rejects the setting is retried once without it.
     */
    thinkingBudget?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function usageOf(response: GeminiResponseLike): AiUsage {
    const u = response.usageMetadata ?? {};
    return { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, thoughtTokens: u.thoughtsTokenCount ?? 0 };
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
    return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, thoughtTokens: (a.thoughtTokens ?? 0) + (b.thoughtTokens ?? 0) };
}

export class GeminiProvider implements AiProvider {
    readonly name = "gemini";
    readonly model: string;
    private client?: GeminiClientLike;
    private readonly apiKey: string;
    private readonly maxRetries: number;
    private readonly retryDelayMs: number;
    private readonly defaultMaxOutputTokens: number;
    private thinkingBudget: number | undefined;

    /** The first attempt plus retries: how many billed requests one call can make. */
    get maxAttempts(): number {
        return this.maxRetries + 1;
    }

    constructor(options: GeminiOptions) {
        if (!options.apiKey) throw new AiError("Gemini API key is missing", false);
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.client = options.client;
        this.maxRetries = options.maxRetries ?? 2;
        this.retryDelayMs = options.retryDelayMs ?? 1500;
        this.defaultMaxOutputTokens = options.defaultMaxOutputTokens ?? 8192;
        this.thinkingBudget = options.thinkingBudget ?? 0;
    }

    private buildConfig(request: AiJsonRequest): Record<string, unknown> {
        const config: Record<string, unknown> = {
            systemInstruction: request.system,
            temperature: 0,
            maxOutputTokens: request.maxOutputTokens ?? this.defaultMaxOutputTokens,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema
        };
        if (this.thinkingBudget !== undefined && this.thinkingBudget >= 0) {
            config.thinkingConfig = { thinkingBudget: this.thinkingBudget };
        }
        return config;
    }

    private async getClient(): Promise<GeminiClientLike> {
        if (!this.client) {
            const { GoogleGenAI } = await import("@google/genai");
            this.client = new GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiClientLike;
        }
        return this.client;
    }

    async generateJson(request: AiJsonRequest): Promise<AiJsonResponse> {
        const client = await this.getClient();
        let lastError: AiError | undefined;
        // Answers that came back but could not be used (empty, not JSON, cut off) are billed, so their
        // tokens are carried into the call's usage (or the final error) and cost accounting sees every retry.
        let billed: AiUsage | undefined;
        let retries = 0;
        const withAccounting = (error: AiError): AiError => {
            if (billed) error.usage = billed;
            error.retries = retries;
            return error;
        };

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            let response: GeminiResponseLike | undefined;
            try {
                response = await client.models.generateContent({
                    model: this.model,
                    contents: request.prompt,
                    config: this.buildConfig(request)
                });
                const parsed = this.parseResponse(response);
                return {
                    ...parsed,
                    usage: billed ? addUsage(billed, parsed.usage) : parsed.usage,
                    ...(retries > 0 ? { retries } : {})
                };
            } catch (error) {
                lastError = this.toAiError(error);
                if (response) billed = addUsage(billed ?? { inputTokens: 0, outputTokens: 0, thoughtTokens: 0 }, usageOf(response));
                // A model that does not accept a thinking budget: drop the setting and retry at once.
                if (lastError.status === 400 && this.thinkingBudget !== undefined && /thinking/i.test(lastError.message)) {
                    this.thinkingBudget = undefined;
                    attempt--;
                    continue;
                }
                if (!lastError.retryable || attempt === this.maxRetries) throw withAccounting(lastError);
                retries++;
                if (this.retryDelayMs > 0) await sleep(this.retryDelayMs * Math.pow(2, attempt));
            }
        }
        throw withAccounting(lastError ?? new AiError("Gemini call failed", false));
    }

    private parseResponse(response: GeminiResponseLike): AiJsonResponse {
        if (response.promptFeedback?.blockReason) {
            throw new AiError(`Gemini blocked the prompt (${response.promptFeedback.blockReason})`, false);
        }
        const finish = response.candidates?.[0]?.finishReason;
        if (finish && finish !== "STOP") {
            // MAX_TOKENS, SAFETY, RECITATION, ...: the answer is incomplete or withheld. Say how much
            // came back and how it starts and ends, so a runaway or looping answer can be diagnosed.
            const partial = (response.text ?? "").replace(/\s+/g, " ");
            const detail = partial.length > 0
                ? ` after ${partial.length} chars (starts ${JSON.stringify(partial.slice(0, 120))}, ends ${JSON.stringify(partial.slice(-120))})`
                : "";
            throw new AiError(`Gemini stopped with finishReason ${finish}${detail}`, finish === "OTHER");
        }
        const text = response.text;
        if (!text || text.trim().length === 0) {
            throw new AiError("Gemini returned an empty response", true);
        }
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new AiError(`Gemini response is not valid JSON: ${(error as Error).message}`, true);
        }
        const usage = response.usageMetadata ?? {};
        return {
            data,
            usage: {
                inputTokens: usage.promptTokenCount ?? 0,
                outputTokens: usage.candidatesTokenCount ?? 0,
                thoughtTokens: usage.thoughtsTokenCount
            },
            model: response.modelVersion ?? this.model
        };
    }

    private toAiError(error: unknown): AiError {
        if (error instanceof AiError) {
            return new AiError(redactSecret(error.message, this.apiKey), error.retryable, error.status);
        }
        const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = redactSecret(rawMessage, this.apiKey);
        if (status !== undefined) {
            return new AiError(`Gemini API error ${status}: ${message}`, RETRYABLE_STATUS.has(status), status);
        }
        const networkish = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|timeout/i.test(message);
        return new AiError(`Gemini call failed: ${message}`, networkish);
    }
}
