/**
 * Roblox service status (structured JSON source, deterministic parse).
 *
 * Source: the hostedstatus.com feed behind status.roblox.com. We read
 * `result.status_overall`: `updated` is when the overall status last changed
 * and `status` is its text ("Operational", ...).
 *
 * Fetching goes through the smart fetch layer: conditional requests, content
 * validation (a 200 that is not JSON is a failure, not data), text hashing so an
 * unchanged feed does no downstream work, and per-source fetch state persisted
 * in the knowledge file.
 *
 * Semantics preserved from V1 for compatibility: the published instant is the
 * last overall-status change, which the site renders as "time since". That is a
 * weak tracker (it is not an outage or a release); redesigning it is out of
 * scope. Each distinct `updated` value becomes one observed event, so the
 * knowledge file accumulates a history of overall-status changes.
 */
import { Adapter } from "../adapter";
import { failureKindFromFetch } from "../reasons";
import { SourceState } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
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

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering for JSON). */
export function createRobloxStatusAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const previous = stored && stored.url === source.url ? stored : undefined;

        const fetched = await smartFetch(source.url, {
            expect: { kind: "json" },
            allowRender: false,
            previous,
            transport,
            label: `${game.id}-${topic.type}`,
            now
        });
        const sourceStates: SourceState[] = [{ id: source.id, url: source.url, ...fetched.state }];

        if (fetched.outcome === "unusable") {
            const reason = fetched.error ?? fetched.verdict?.reason ?? "fetch failed";
            return { events: [], failure: reason, failureKind: failureKindFromFetch(fetched), sourceStates };
        }

        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };

        if (fetched.outcome === "unchanged") {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        // Syntactically valid JSON with the wrong shape is a source failure too: record it
        // on the source state instead of throwing past the pipeline's bookkeeping.
        let snapshot: HostedStatusSnapshot;
        try {
            snapshot = parseHostedStatus(fetched.document!.body);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            sourceStates[0] = {
                ...sourceStates[0],
                // Drop validators: a 304 against bad content must not read as "unchanged, still good".
                etag: undefined,
                lastModified: undefined,
                textHash: previous?.textHash,
                lastUsableAt: previous?.lastUsableAt,
                lastVerdict: "parse-error",
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
            };
            return { events: [], failure: reason, failureKind: "extraction-failed", sourceStates };
        }
        return {
            events: [{
                identity: instantIdentity(snapshot.updated),
                label: snapshot.status,
                status: "observed",
                at: snapshot.updated,
                precision: "exact",
                timezone: "UTC"
            }],
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
