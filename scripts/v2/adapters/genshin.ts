/**
 * Genshin Impact current banner end (structured JSON, deterministic parse).
 *
 * Source: HoYoverse's official in-game announcement list, requested once per server region (America os_usa,
 * Europe os_euro, Asia os_asia). Each response states its region's UTC offset in `data.timezone` (-5, 1, 8) and
 * lists "Event Wish ..." announcements with `end_time` as that region's server wall clock.
 *
 * Time zone semantics (never the runner's local zone): a wish phase ends at the same server wall clock in every
 * region, so one phase has three real instants. The page answers "how much time is left to pull", so the published
 * `nextEventUtc` is the EARLIEST regional end: nobody is told they have more time than they do. The label names all
 * three regional instants. Each region's instant uses the offset that region's own response states; a phase is
 * published only when all three regions list the same end wall clock.
 *
 * `start_time` is not used: it is when the notice appears in the client (and differs by region), not the phase start.
 * Version dates from the "Update Details" notices are not used: their end times do not convert to one instant.
 *
 * Requests carry no conditional headers (the API can then never answer 304 without a body), and change is detected by
 * the text hash of each regional response. No model is involved.
 *
 * Evidence names the fetched Asia response (URL and content hash); the claim quotes, verbatim, the first wish entry
 * of the phase from that response, which states the end wall clock; the same document states the Asia offset.
 *
 * Risks: the API is undocumented and needs placeholder `level`/`uid` parameters; it could change.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { failureKindFromFetch } from "../reasons";
import { Adapter, AdapterOutcome, EventInput } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";
import { jsonObjectSpans } from "../json-quote";

const ANNOUNCEMENTS_BASE = "https://sg-hk4e-api.hoyoverse.com/common/hk4e_global/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_global&lang=en&bundle_id=hk4e_global&platform=pc&level=55&uid=100000000";
export const GENSHIN_NEWS_PAGE = "https://genshin.hoyoverse.com/en/news";

/** Regions in publication order: the earliest end first. */
export const GENSHIN_REGIONS = [
    { region: "os_asia", name: "Asia" },
    { region: "os_euro", name: "Europe" },
    { region: "os_usa", name: "America" }
] as const;
export type GenshinRegion = typeof GENSHIN_REGIONS[number]["region"];

export function genshinAnnouncementsUrl(region: GenshinRegion): string {
    return `${ANNOUNCEMENTS_BASE}&region=${region}`;
}

export function genshinSourceId(region: GenshinRegion): string {
    return `genshin-announcements-${region}`;
}

export interface WishPhase {
    /** `end_time` exactly as listed: the server wall clock, identical in every region. */
    endWall: string;
    /** This region's end instant, ISO 8601 UTC. */
    endAt: string;
    /** Wish names from the titles, e.g. "The Lone Light Knocks at Night". */
    names: string[];
    annIds: number[];
    /** The first wish entry of the phase, verbatim from the response text. */
    excerpt: string;
}

export interface RegionalWishes {
    /** UTC offset in hours, as `data.timezone` states it. */
    timezone: number;
    phases: WishPhase[];
}

const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const WISH_TITLE = /^Event Wish "([^"]+)"/;

/** Wish phases in one regional announcement list. Throws when the response is not the announcement shape. */
export function parseWishPhases(text: string): RegionalWishes {
    let body: any;
    try {
        body = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in the Genshin announcement list");
    }
    if (body?.retcode !== 0) throw new Error(`Genshin announcement list returned retcode ${JSON.stringify(body?.retcode)}`);
    const timezone = body?.data?.timezone;
    if (!Number.isInteger(timezone) || timezone < -12 || timezone > 14) throw new Error(`No usable data.timezone in the Genshin announcement list (${JSON.stringify(timezone)})`);
    const groups = body?.data?.list;
    if (!Array.isArray(groups)) throw new Error("No data.list in the Genshin announcement list");

    // Verbatim entries by ann_id (numbers, so the generic string index does not apply).
    const entries = new Map<number, string>();
    for (const [start, end] of jsonObjectSpans(text)) {
        const slice = text.slice(start, end);
        if (!slice.includes("\"ann_id\"")) continue;
        try {
            const o = JSON.parse(slice);
            if (Number.isInteger(o?.ann_id) && typeof o?.title === "string" && !entries.has(o.ann_id)) entries.set(o.ann_id, slice);
        } catch {
            // Not a standalone object.
        }
    }

    const byEnd = new Map<string, WishPhase>();
    for (const group of groups) {
        for (const item of Array.isArray(group?.list) ? group.list : []) {
            const title = typeof item?.title === "string" ? item.title.trim() : "";
            const name = WISH_TITLE.exec(title)?.[1];
            const wall = typeof item?.end_time === "string" ? WALL.exec(item.end_time) : null;
            const excerpt = Number.isInteger(item?.ann_id) ? entries.get(item.ann_id) : undefined;
            if (!name || !wall || !excerpt) continue;
            const [, y, mo, d, h, mi, s] = wall.map(Number) as unknown as number[];
            const local = Date.UTC(y, mo - 1, d, h, mi, s);
            const check = new Date(local);
            // Date.UTC normalizes out-of-range fields (14:60:00 becomes 15:00:00, September 31 becomes October 1):
            // a malformed wall clock rejects the response instead of publishing a shifted end.
            if (h > 23 || mi > 59 || s > 59 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
                throw new Error(`Invalid end_time ${JSON.stringify(item.end_time)} for Genshin announcement ${item.ann_id}`);
            }
            const endAt = new Date(local - timezone * 3_600_000).toISOString();
            const phase: WishPhase = byEnd.get(item.end_time) ?? { endWall: item.end_time, endAt, names: [], annIds: [], excerpt };
            phase.names.push(name);
            phase.annIds.push(item.ann_id);
            byEnd.set(item.end_time, phase);
        }
    }
    return { timezone, phases: [...byEnd.values()].sort((a, b) => a.endAt.localeCompare(b.endAt)) };
}

function hhmm(iso: string): string {
    return iso.slice(11, 16);
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

export function createGenshinWishAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState, knowledge }) => {
        const sourceStates: SourceState[] = [];
        const documents = new Map<GenshinRegion, FetchedDocument>();
        let unchanged = 0;
        let httpStatus = 200;
        for (const { region } of GENSHIN_REGIONS) {
            const id = genshinSourceId(region);
            const source = game.sources.find(s => s.id === id);
            if (!source) throw new Error(`Source ${id} is not configured for ${game.id}`);
            const stored = getSourceState(id);
            // No conditional headers: a 304 would carry no body, and all three regions are needed together.
            const previous = stored && stored.url === source.url ? { ...stored, etag: undefined, lastModified: undefined } : undefined;
            const fetched = await smartFetch(source.url, { expect: { kind: "json" }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}-${region}`, now });
            sourceStates.push({ id, url: source.url, ...fetched.state, etag: undefined, lastModified: undefined });
            if (fetched.outcome === "unusable" || !fetched.document) {
                // Regions fetched earlier in this run were never parsed: keep their last accepted hashes, so a changed
                // region is examined again next run instead of passing as unchanged.
                for (let i = 0; i < sourceStates.length - 1; i++) {
                    sourceStates[i] = { ...sourceStates[i], textHash: getSourceState(sourceStates[i].id)?.textHash };
                }
                return { events: [], failure: `${region}: ${fetched.error ?? fetched.verdict?.reason ?? "fetch failed"}`, failureKind: failureKindFromFetch(fetched), sourceStates };
            }
            if (fetched.outcome === "unchanged") unchanged++;
            httpStatus = fetched.document.status;
            documents.set(region, fetched.document);
        }
        const fetch = { httpStatus, mode: "http" as const };
        if (unchanged === GENSHIN_REGIONS.length) {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 3, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        // Keep every region's last good hash when any region cannot be trusted, so all are examined again next run.
        const reject = (reason: string): AdapterOutcome => {
            for (let i = 0; i < sourceStates.length; i++) {
                const stored = getSourceState(sourceStates[i].id);
                sourceStates[i] = { ...sourceStates[i], textHash: stored?.textHash, lastUsableAt: stored?.lastUsableAt, lastVerdict: "parse-error", consecutiveFailures: (stored?.consecutiveFailures ?? 0) + 1 };
            }
            return { events: [], failure: reason, failureKind: "extraction-failed", sourceStates };
        };
        const regional = new Map<GenshinRegion, RegionalWishes>();
        try {
            for (const { region } of GENSHIN_REGIONS) regional.set(region, parseWishPhases(documents.get(region)!.body));
        } catch (error) {
            return reject(error instanceof Error ? error.message : String(error));
        }

        const asia = regional.get("os_asia")!;
        const events: EventInput[] = [];
        const claims: Claim[] = [];
        const asiaDoc = documents.get("os_asia")!;
        for (const phase of asia.phases) {
            const instants = GENSHIN_REGIONS.map(({ region, name }) => ({ name, at: regional.get(region)!.phases.find(p => p.endWall === phase.endWall)?.endAt }));
            if (instants.some(i => i.at === undefined)) {
                return reject(`Event Wishes ending ${phase.endWall} are not listed in every region`);
            }
            const earliest = instants.map(i => i.at!).sort()[0];
            const regions = instants.map(i => `${i.name} ${hhmm(i.at!)} UTC`).join(", ");
            const endDay = instants[0].at!.slice(0, 10);
            events.push({
                identity: `event-wishes-${phase.endWall}`,
                label: `${phase.names.join(" / ")}: ends ${phase.endWall.slice(0, 16)} server time (${regions}${endDay !== instants[2].at!.slice(0, 10) ? ", dates vary" : ""})`,
                status: Date.parse(earliest) > now.getTime() ? "scheduled" : "ended",
                at: earliest,
                precision: "exact",
                timezone: "UTC"
            });
            const key = eventKey(game.id, topic.type, `event-wishes-${phase.endWall}`);
            if (!knowledge.claims.some(c => c.eventKey === key && c.field === "at" && c.value === earliest)) {
                claims.push({ id: sha(`${asiaDoc.textHash}|${key}|at|${earliest}`).slice(0, 24), documentId: asiaDoc.textHash, eventKey: key, field: "at", value: earliest, method: "deterministic", quote: phase.excerpt, extractedAt: asiaDoc.fetchedAt });
            }
        }
        if (events.length === 0) return reject("no \"Event Wish\" announcement in the Genshin announcement list");

        const docs: Document[] = claims.length === 0 ? [] : [{ id: asiaDoc.textHash, url: asiaDoc.finalUrl, sourceId: genshinSourceId("os_asia"), fetchedAt: asiaDoc.fetchedAt, title: "Genshin Impact announcements (Asia server)", fetchMode: asiaDoc.mode, confidence: Confidence.High }];
        // The lists are complete: a phase that is corrected, postponed or withdrawn stops being published.
        return { events, listsAllScheduled: true, documents: docs, claims, confidence: Confidence.High, sourceStates, fetch, work: { unchanged, deterministic: GENSHIN_REGIONS.length - unchanged, sentToAi: 0, deferred: 0 } };
    };
}

