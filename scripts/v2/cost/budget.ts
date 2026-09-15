/**
 * AI budget gate: every model call a refresh run makes goes through it.
 *
 *   limits   AI_DAILY_COST_LIMIT_USD (default 2.00), AI_DAILY_CALL_LIMIT (100) and
 *            AI_PER_TOPIC_CALL_LIMIT (5 per topic per UTC day): safety ceilings,
 *            not targets
 *   check    before a document is sent at all, its worst case (every call it may
 *            need, each at its output cap and with every retry the provider may
 *            make) must fit what is left of today's budget; each single call is
 *            checked again right before it is made, against the UTC day it is
 *            made in
 *   record   every call made, successful or not, lands in the usage ledger with
 *            its tokens and an estimated cost
 *
 * When a limit would be exceeded no call is made. Callers defer the work: last
 * known-good knowledge stays published, the document is not marked as seen, and
 * a later run retries. They never guess or publish weaker information instead.
 */
import { AiError, AiJsonRequest, AiJsonResponse, AiProvider, AiUsage } from "../ai/provider";
import { AiCallRecord, AiUsageLedger, utcDate } from "./ledger";
import { estimateCost, priceFor } from "./pricing";

export interface AiBudgetLimits {
    /** Estimated USD per UTC day, across every topic. */
    dailyCostUsd: number;
    /** Model calls per UTC day, across every topic. */
    dailyCalls: number;
    /** Model calls per topic per UTC day. */
    perTopicCalls: number;
}

export const DEFAULT_AI_BUDGET_LIMITS: Readonly<AiBudgetLimits> = { dailyCostUsd: 2.0, dailyCalls: 100, perTopicCalls: 5 };

function readLimit(env: NodeJS.ProcessEnv, name: string, fallback: number, integer: boolean): number {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        throw new Error(`${name} must be a non-negative ${integer ? "integer" : "number"}, got ${JSON.stringify(raw)}`);
    }
    return value;
}

/** Reads the limits from the environment; unset variables take the defaults, invalid ones throw. */
export function readAiBudgetLimits(env: NodeJS.ProcessEnv = process.env): AiBudgetLimits {
    return {
        dailyCostUsd: readLimit(env, "AI_DAILY_COST_LIMIT_USD", DEFAULT_AI_BUDGET_LIMITS.dailyCostUsd, false),
        dailyCalls: readLimit(env, "AI_DAILY_CALL_LIMIT", DEFAULT_AI_BUDGET_LIMITS.dailyCalls, true),
        perTopicCalls: readLimit(env, "AI_PER_TOPIC_CALL_LIMIT", DEFAULT_AI_BUDGET_LIMITS.perTopicCalls, true)
    };
}

export type AiBudgetReason = "daily-cost" | "daily-calls" | "topic-calls" | "ledger-unreadable" | "budget-unavailable";

/** Thrown instead of making a call the budget does not allow. Not a model failure: the work is deferred. */
export class AiBudgetExceededError extends Error {
    constructor(public readonly reason: AiBudgetReason, public readonly detail: string) {
        super(`AI budget exhausted (${reason}): ${detail}`);
        this.name = "AiBudgetExceededError";
    }
}

/** One model call a piece of work may make, sized for its worst case. */
export interface PlannedCall {
    /** Characters of system instruction plus prompt. */
    promptChars: number;
    /** The call's output token cap: the most output one attempt can bill. */
    maxOutputTokens: number;
}

export type BudgetCheck = { ok: true; projectedCostUsd: number } | { ok: false; reason: AiBudgetReason; detail: string };

/** Characters per token assumed when projecting input tokens. Low on purpose (English runs near 4), so projections overestimate. */
export const PROJECTION_CHARS_PER_TOKEN = 3;

/** Output cap assumed for a request that sets none (the Gemini provider's default). */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface AiGate {
    readonly limits: AiBudgetLimits;
    readonly ledger: AiUsageLedger;
    readonly runId: string;
    /** Whether the planned calls fit every limit for this topic today. Makes no call and records nothing. */
    check(game: string, topic: string, now: Date, calls: PlannedCall[]): BudgetCheck;
    /** The budgeted provider for one topic, or undefined when no AI provider is configured. */
    providerFor(game: string, topic: string, now: Date): Promise<AiProvider | undefined>;
    /** Calls recorded through this gate so far (this process), optionally for one topic. */
    callsMade(game?: string, topic?: string): AiCallRecord[];
}

export interface AiGateOptions {
    ledger: AiUsageLedger;
    limits: AiBudgetLimits;
    runId: string;
    /** Loads the configured provider (once); resolves undefined when none is configured. */
    loadProvider: () => Promise<AiProvider | undefined>;
    /** When set, every check fails with this explanation: usage cannot be tracked, or the limits are invalid. */
    unavailable?: string;
    /**
     * The current time, read at every check and call, so a run that crosses UTC midnight counts later calls
     * against the new day. Without it the tracker's run time is used (tests and simulated runs).
     */
    clock?: () => Date;
    env?: NodeJS.ProcessEnv;
}

class BudgetGate implements AiGate {
    readonly limits: AiBudgetLimits;
    readonly ledger: AiUsageLedger;
    readonly runId: string;
    private provider?: Promise<AiProvider | undefined>;
    private model?: string;
    /** Requests one call may send (first attempt plus retries), from the loaded provider. */
    private attempts = 1;
    private readonly made: AiCallRecord[] = [];

    constructor(private readonly options: AiGateOptions) {
        this.limits = options.limits;
        this.ledger = options.ledger;
        this.runId = options.runId;
    }

    /** When a check or call happens: the clock when configured, else the tracker's run time. */
    at(now: Date): Date {
        return this.options.clock ? this.options.clock() : now;
    }

    record(entry: AiCallRecord): void {
        this.ledger.record(entry);
        this.made.push(entry);
    }

    callsMade(game?: string, topic?: string): AiCallRecord[] {
        return this.made.filter(r => (game === undefined || r.game === game) && (topic === undefined || r.topic === topic));
    }

    check(game: string, topic: string, now: Date, calls: PlannedCall[]): BudgetCheck {
        if (this.options.unavailable) return { ok: false, reason: "budget-unavailable", detail: this.options.unavailable };
        const date = utcDate(this.at(now));
        const unreadable = this.ledger.unreadableReason(date);
        if (unreadable) return { ok: false, reason: "ledger-unreadable", detail: `today's usage ledger cannot be read, so no call is made until it is fixed (${unreadable})` };

        const planned = calls.length;
        const day = this.ledger.totals(date);
        if (day.calls + planned > this.limits.dailyCalls) {
            return { ok: false, reason: "daily-calls", detail: `${day.calls} of ${this.limits.dailyCalls} calls used today (UTC ${date}); this work needs up to ${planned} more` };
        }
        const topicCalls = this.ledger.totals(date, r => r.game === game && r.topic === topic).calls;
        if (topicCalls + planned > this.limits.perTopicCalls) {
            return { ok: false, reason: "topic-calls", detail: `${game}/${topic} used ${topicCalls} of ${this.limits.perTopicCalls} calls today (UTC ${date}); this work needs up to ${planned} more` };
        }
        const price = priceFor(this.model ?? "unknown", this.options.env);
        // Every attempt the provider may send for a call can be billed (retried answers that came back unusable).
        const perAttempt = calls.reduce((sum, c) => sum + estimateCost(price, { inputTokens: Math.ceil(c.promptChars / PROJECTION_CHARS_PER_TOKEN), outputTokens: c.maxOutputTokens }).totalUsd, 0);
        const projected = perAttempt * this.attempts;
        if (day.estimatedCostUsd + projected > this.limits.dailyCostUsd) {
            const retries = this.attempts > 1 ? ` (each call may take up to ${this.attempts} attempts)` : "";
            return {
                ok: false,
                reason: "daily-cost",
                detail: `an estimated $${day.estimatedCostUsd.toFixed(4)} of $${this.limits.dailyCostUsd.toFixed(2)} spent today (UTC ${date}); this work could cost up to $${projected.toFixed(4)}${retries}`
            };
        }
        return { ok: true, projectedCostUsd: projected };
    }

    async providerFor(game: string, topic: string, now: Date): Promise<AiProvider | undefined> {
        if (!this.provider) this.provider = this.options.loadProvider();
        const inner = await this.provider;
        if (!inner) return undefined;
        this.model = inner.model;
        this.attempts = Math.max(1, Math.floor(inner.maxAttempts ?? 1));
        return new BudgetedAiProvider(inner, this, game, topic, now, this.options.env);
    }
}

/** The kind of failure only: any quoted model output a provider message carries is dropped. */
function shortError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s*\(starts [\s\S]*$/, "").slice(0, 160);
}

/** A provider for one topic that checks the budget before every call and records every call it makes. */
class BudgetedAiProvider implements AiProvider {
    constructor(
        private readonly inner: AiProvider,
        private readonly gate: BudgetGate,
        private readonly game: string,
        private readonly topic: string,
        private readonly now: Date,
        private readonly env?: NodeJS.ProcessEnv
    ) { }

    get name(): string { return this.inner.name; }
    get model(): string { return this.inner.model; }
    get maxAttempts(): number | undefined { return this.inner.maxAttempts; }

    async generateJson(request: AiJsonRequest): Promise<AiJsonResponse> {
        const verdict = this.gate.check(this.game, this.topic, this.now, [{
            promptChars: request.system.length + request.prompt.length,
            maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
        }]);
        if (!verdict.ok) throw new AiBudgetExceededError(verdict.reason, verdict.detail);

        const price = priceFor(this.inner.model, this.env);
        const record = (success: boolean, usage: AiUsage | undefined, retries: number, error?: unknown) => {
            const tokens = usage ?? { inputTokens: 0, outputTokens: 0 };
            const cost = estimateCost(price, tokens);
            this.gate.record({
                at: this.gate.at(this.now).toISOString(),
                runId: this.gate.runId,
                provider: this.inner.name,
                model: this.inner.model,
                game: this.game,
                topic: this.topic,
                operation: request.label,
                repair: request.label.endsWith("-repair"),
                success,
                retries,
                inputTokens: tokens.inputTokens,
                outputTokens: tokens.outputTokens,
                thoughtTokens: tokens.thoughtTokens ?? 0,
                estimatedInputCostUsd: cost.inputUsd,
                estimatedOutputCostUsd: cost.outputUsd,
                estimatedCostUsd: cost.totalUsd,
                priceSource: price.source,
                ...(error !== undefined ? { error: shortError(error) } : {})
            });
        };
        try {
            const response = await this.inner.generateJson(request);
            record(true, response.usage, response.retries ?? 0);
            return response;
        } catch (error) {
            // Answers that came back unusable are billed; the provider reports their tokens on the error when it can.
            const aiError = error instanceof AiError ? error : undefined;
            record(false, aiError?.usage, aiError?.retries ?? 0, error);
            throw error;
        }
    }
}

export function createAiGate(options: AiGateOptions): AiGate {
    return new BudgetGate(options);
}

/** The run id recorded with each call: the GitHub Actions run when present, else a local timestamp. */
export function currentRunId(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
    return env.GITHUB_RUN_ID ? `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${now.toISOString()}`;
}
