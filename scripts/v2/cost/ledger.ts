/**
 * AI usage ledger: one record per model call, grouped by UTC day.
 *
 * In CI the ledger lives in the knowledge branch worktree
 * (`knowledge/usage/ai/<YYYY-MM-DD>.json`), so the daily budget holds across the
 * separate refresh runs of a day. Records hold counts, tokens and estimated
 * costs only: never prompts, documents, responses or keys.
 *
 * A day file that exists but cannot be read is not silently replaced: the
 * ledger reports it as unreadable and the budget gate treats the day as
 * exhausted until a person looks at it.
 */
import * as fs from "fs";
import * as path from "path";

export const AI_LEDGER_SCHEMA_VERSION = 1;

export interface AiCallRecord {
    at: string;
    runId: string;
    provider: string;
    model: string;
    game: string;
    topic: string;
    /** Request label: classify, extract, extract-repair, relevance. */
    operation: string;
    /** The call was a repair retry of an earlier extraction. */
    repair: boolean;
    success: boolean;
    /** Retries the provider made inside this call (transient errors, unusable answers). */
    retries: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    estimatedInputCostUsd: number;
    estimatedOutputCostUsd: number;
    estimatedCostUsd: number;
    priceSource: string;
    /** Short failure message (already free of secrets), when the call failed. */
    error?: string;
}

export interface LedgerTotals {
    calls: number;
    failures: number;
    repairs: number;
    retries: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    estimatedCostUsd: number;
}

export function emptyTotals(): LedgerTotals {
    return { calls: 0, failures: 0, repairs: 0, retries: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, estimatedCostUsd: 0 };
}

export function utcDate(now: Date): string {
    return now.toISOString().slice(0, 10);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is AiCallRecord {
    if (typeof value !== "object" || value === null) return false;
    const r = value as Record<string, unknown>;
    const strings = ["at", "runId", "provider", "model", "game", "topic", "operation", "priceSource"];
    const numbers = ["retries", "inputTokens", "outputTokens", "thoughtTokens", "estimatedInputCostUsd", "estimatedOutputCostUsd", "estimatedCostUsd"];
    return strings.every(k => typeof r[k] === "string")
        && numbers.every(k => typeof r[k] === "number" && Number.isFinite(r[k] as number) && (r[k] as number) >= 0)
        && typeof r.repair === "boolean"
        && typeof r.success === "boolean"
        && (r.error === undefined || typeof r.error === "string")
        && !isNaN(Date.parse(r.at as string));
}

export class AiUsageLedger {
    private readonly days = new Map<string, AiCallRecord[]>();
    private readonly unreadable = new Map<string, string>();

    private constructor(private readonly dir?: string) { }

    /** A ledger that forgets everything when the process ends (tests, local tools). */
    static inMemory(): AiUsageLedger {
        return new AiUsageLedger();
    }

    /** A ledger persisted as one JSON file per UTC day in `dir`. */
    static inDirectory(dir: string): AiUsageLedger {
        return new AiUsageLedger(dir);
    }

    get location(): string {
        return this.dir ?? "(in memory)";
    }

    private fileFor(date: string): string {
        return path.join(this.dir!, `${date}.json`);
    }

    private load(date: string): AiCallRecord[] {
        if (!DATE.test(date)) throw new Error(`invalid ledger date ${JSON.stringify(date)}`);
        const cached = this.days.get(date);
        if (cached) return cached;
        let records: AiCallRecord[] = [];
        if (this.dir) {
            const file = this.fileFor(date);
            if (fs.existsSync(file)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion?: unknown; date?: unknown; calls?: unknown };
                    if (parsed.schemaVersion !== AI_LEDGER_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${AI_LEDGER_SCHEMA_VERSION}`);
                    if (parsed.date !== date) throw new Error(`file is for ${JSON.stringify(parsed.date)}`);
                    if (!Array.isArray(parsed.calls) || !parsed.calls.every(isRecord)) throw new Error("calls must be valid call records");
                    records = parsed.calls as AiCallRecord[];
                } catch (error) {
                    this.unreadable.set(date, `${file}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        this.days.set(date, records);
        return records;
    }

    /** Why the day's ledger file could not be read, or undefined when it is fine (or absent). */
    unreadableReason(date: string): string | undefined {
        this.load(date);
        return this.unreadable.get(date);
    }

    calls(date: string): readonly AiCallRecord[] {
        return this.load(date);
    }

    record(entry: AiCallRecord): void {
        const date = entry.at.slice(0, 10);
        const records = this.load(date);
        records.push(entry);
        // Never overwrite a day file that could not be read; the gate blocks calls for that day anyway.
        if (this.dir && !this.unreadable.has(date)) {
            fs.mkdirSync(this.dir, { recursive: true });
            const file = this.fileFor(date);
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: AI_LEDGER_SCHEMA_VERSION, date, calls: records }, null, 2) + "\n", "utf8");
            fs.renameSync(tmp, file);
        }
    }

    totals(date: string, filter: (record: AiCallRecord) => boolean = () => true): LedgerTotals {
        const totals = emptyTotals();
        for (const r of this.load(date)) {
            if (!filter(r)) continue;
            totals.calls++;
            if (!r.success) totals.failures++;
            if (r.repair) totals.repairs++;
            totals.retries += r.retries;
            totals.inputTokens += r.inputTokens;
            totals.outputTokens += r.outputTokens;
            totals.thoughtTokens += r.thoughtTokens;
            totals.estimatedCostUsd += r.estimatedCostUsd;
        }
        return totals;
    }
}
