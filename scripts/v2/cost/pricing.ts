/**
 * Model prices for cost ESTIMATES. These numbers are list prices copied by hand
 * from the provider's pricing page; they are not billing data and can drift.
 * Every cost the pipeline reports is labelled an estimate for that reason.
 *
 * This is the only place prices live. Override for a run with
 * AI_PRICE_INPUT_PER_M and AI_PRICE_OUTPUT_PER_M (USD per million tokens).
 */

export interface ModelPrice {
    /** USD per million input tokens. */
    inputPerMillionUsd: number;
    /** USD per million output tokens (thinking tokens are billed as output). */
    outputPerMillionUsd: number;
    /** Where the numbers come from. */
    source: string;
}

const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
    "gemini-3.5-flash": {
        inputPerMillionUsd: 1.5,
        outputPerMillionUsd: 9.0,
        source: "Gemini API pricing page, paid tier, read 2026-09-15"
    }
};

export function knownModelPrice(model: string): ModelPrice | undefined {
    return MODEL_PRICES[model];
}


function readPrice(env: NodeJS.ProcessEnv, name: string): number | undefined {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of USD per million tokens, got ${JSON.stringify(raw)}`);
    return value;
}

/**
 * The price used to estimate a model's cost: the environment override when set, else the table. Undefined for a
 * model with neither: its cost cannot be bounded, so budget checks refuse its calls (fail closed).
 */
export function priceFor(model: string, env: NodeJS.ProcessEnv = process.env): ModelPrice | undefined {
    const input = readPrice(env, "AI_PRICE_INPUT_PER_M");
    const output = readPrice(env, "AI_PRICE_OUTPUT_PER_M");
    if ((input === undefined) !== (output === undefined)) {
        throw new Error("Set both AI_PRICE_INPUT_PER_M and AI_PRICE_OUTPUT_PER_M, or neither");
    }
    if (input !== undefined && output !== undefined) {
        return { inputPerMillionUsd: input, outputPerMillionUsd: output, source: "AI_PRICE_INPUT_PER_M / AI_PRICE_OUTPUT_PER_M override" };
    }
    return MODEL_PRICES[model];
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    thoughtTokens?: number;
}

export interface CostEstimate {
    inputUsd: number;
    outputUsd: number;
    totalUsd: number;
}

/** Estimated cost of a call. Thinking tokens are billed as output tokens. */
export function estimateCost(price: ModelPrice, usage: TokenUsage): CostEstimate {
    const inputUsd = (usage.inputTokens / 1e6) * price.inputPerMillionUsd;
    const outputUsd = ((usage.outputTokens + (usage.thoughtTokens ?? 0)) / 1e6) * price.outputPerMillionUsd;
    return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

export function formatUsd(value: number): string {
    return `$${value.toFixed(4)}`;
}
