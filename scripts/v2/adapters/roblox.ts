/**
 * Roblox service status (structured JSON source, deterministic parse).
 *
 * Source: the hostedstatus.com feed behind status.roblox.com. We read
 * `result.status_overall`: `updated` is when the overall status last changed
 * and `status` is its text ("Operational", ...).
 *
 * Semantics preserved from V1 for compatibility: the published instant is the
 * last overall-status change, which the site renders as "time since". That is a
 * weak tracker (it is not an outage or a release); redesigning it is out of
 * scope for this PR. Each distinct `updated` value becomes one observed event,
 * so the knowledge file accumulates a history of overall-status changes.
 */
import { Adapter } from "../adapter";
import { instantIdentity } from "../identity";

export interface HostedStatusSnapshot {
    status: string;
    /** ISO 8601 UTC instant of the last overall-status change. */
    updated: string;
    statusCode?: number;
}

export function parseHostedStatus(text: string): HostedStatusSnapshot {
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in Roblox status response");
    }

    const overall = data?.result?.status_overall;
    if (!overall || typeof overall !== "object") {
        throw new Error("No result.status_overall in Roblox status JSON");
    }

    const updatedRaw = overall.updated;
    if (updatedRaw === undefined || updatedRaw === null || updatedRaw === "") {
        throw new Error("No updated timestamp found in Roblox status JSON");
    }
    const updated = typeof updatedRaw === "number" ? new Date(updatedRaw * 1000) : new Date(String(updatedRaw));
    if (isNaN(updated.getTime())) {
        throw new Error(`Invalid date format in Roblox status: ${String(updatedRaw)}`);
    }

    const status = typeof overall.status === "string" && overall.status.trim() ? overall.status.trim() : "unknown";
    const statusCode = typeof overall.status_code === "number" ? overall.status_code : undefined;

    return { status, updated: updated.toISOString(), statusCode };
}

export interface FetchedText {
    ok: boolean;
    status: number;
    text: string;
    mode: "http" | "browser";
    error?: string;
}

export type TextFetcher = (url: string) => Promise<FetchedText>;

/** Production fetcher; loaded lazily so tests never pull in Playwright. */
const defaultFetcher: TextFetcher = async (url) => {
    const { fetchHtml } = await import("../../lib/fetch-layer");
    const response = await fetchHtml(url, { providerId: "roblox" });
    return { ok: response.ok, status: response.status, text: response.text, mode: response.mode, error: response.error };
};

export function createRobloxStatusAdapter(fetcher: TextFetcher = defaultFetcher): Adapter {
    return async ({ game, topic }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        const response = await fetcher(source.url);
        if (!response.ok) throw new Error(response.error || `HTTP ${response.status}`);

        const snapshot = parseHostedStatus(response.text);
        return {
            events: [{
                identity: instantIdentity(snapshot.updated),
                label: snapshot.status,
                status: "observed",
                at: snapshot.updated,
                precision: "exact",
                timezone: "UTC"
            }],
            fetch: { httpStatus: response.status, mode: response.mode }
        };
    };
}
