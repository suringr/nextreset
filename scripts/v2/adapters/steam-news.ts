/**
 * Steam news posts as events (structured JSON source, deterministic parse).
 *
 * Source: the Steam Web API news endpoint for one app, restricted to the
 * publisher's own community announcements. A spec decides which posts are
 * events (a whole-title pattern, optionally a required tag) and what identifies
 * one (Steam's post id, or a version captured from the title).
 *
 * Each accepted post becomes one observed event at its publication time, exact
 * to the second. That is when the publisher announced it, which can differ
 * slightly from when the change went live.
 *
 * Evidence names what was fetched: the document is the API response (its URL
 * and content hash), and each claim quotes its post exactly as it appears in
 * that response. The claim also carries Steam's own link for the post, which
 * becomes the published `source_url`. Evidence is recorded only for post
 * instants that are new to the knowledge file, so a feed that changes for
 * unrelated posts adds no copies.
 *
 * No model is involved: an unchanged response stops at the text hash, and a
 * changed one is parsed by code. A response that is not the news shape, or that
 * holds no accepted post, keeps the last good hash and is reported stale, so a
 * title format change by the publisher is visible instead of silently
 * re-verified.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter, EventInput } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";
import { indexJsonObjects } from "../json-quote";

export interface SteamNewsSpec {
    /** Steam's feed for the publisher's own posts, e.g. "steam_community_announcements". */
    feed: string;
    /** A tag every accepted post must carry (CS2: "patchnotes"). Omit when the publisher does not tag. */
    requireTag?: string;
    /** The whole trimmed title must match. For identity "title", capture group 1 is the identity. */
    title: RegExp;
    identity: "gid" | "title";
    /** Link used when a post carries no https link of its own. */
    fallbackUrl: string;
    /** Failure reason when a valid response holds no accepted post. */
    noPostReason: string;
}

export interface SteamPost {
    /** Steam's post id. */
    gid: string;
    title: string;
    /** Publication time as the API gives it (epoch seconds). */
    date: number;
    /** Publication instant, ISO 8601 UTC. */
    at: string;
    /** Steam's link for the post. */
    url: string;
    /** Event identity per the spec. */
    identity: string;
    /** The post exactly as it appears in the response text. */
    excerpt: string;
}

/** Accepted posts, newest first, one per identity (the first publication wins). Throws when the response is not the news shape. */
export function parseSteamNews(text: string, spec: SteamNewsSpec): SteamPost[] {
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in Steam news response");
    }
    const items = data?.appnews?.newsitems;
    if (!Array.isArray(items)) throw new Error("No appnews.newsitems in Steam news response");

    const quotes = indexJsonObjects(text, "gid");
    const posts: SteamPost[] = [];
    for (const item of items) {
        if (item?.feedname !== spec.feed) continue;
        if (spec.requireTag && (!Array.isArray(item.tags) || !item.tags.includes(spec.requireTag))) continue;
        if (typeof item.title !== "string") continue;
        const title = item.title.trim();
        const match = spec.title.exec(title);
        if (!match) continue;
        if (typeof item.gid !== "string" || !/^\d+$/.test(item.gid)) continue;
        if (typeof item.date !== "number" || !Number.isInteger(item.date) || item.date <= 0) continue;
        const identity = spec.identity === "gid" ? item.gid : match[1];
        const excerpt = quotes.get(item.gid);
        if (!identity || !excerpt) continue;
        posts.push({
            gid: item.gid,
            title,
            date: item.date,
            at: new Date(item.date * 1000).toISOString(),
            url: typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : spec.fallbackUrl,
            identity,
            excerpt
        });
    }
    // Oldest first so the first publication of an identity wins; returned newest first (ties: higher post id first).
    posts.sort((a, b) => a.date - b.date || (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0));
    const seen = new Set<string>();
    const unique = posts.filter(p => {
        if (seen.has(p.identity)) return false;
        seen.add(p.identity);
        return true;
    });
    return unique.reverse();
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering for JSON). */
export function createSteamNewsAdapter(spec: SteamNewsSpec, transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState, knowledge }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const previous = stored && stored.url === source.url ? stored : undefined;

        const fetched = await smartFetch(source.url, { expect: { kind: "json" }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}`, now });
        const sourceStates: SourceState[] = [{ id: source.id, url: source.url, ...fetched.state }];
        if (fetched.outcome === "unusable") {
            return { events: [], failure: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", sourceStates };
        }
        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
        if (fetched.outcome === "unchanged") {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        // Content that cannot be trusted is a source failure. Keep the last good hash and drop validators, so the same
        // content is examined again next run instead of reading as "unchanged, still good".
        const reject = (verdict: string, reason: string) => {
            sourceStates[0] = {
                ...sourceStates[0],
                etag: undefined,
                lastModified: undefined,
                textHash: previous?.textHash,
                lastUsableAt: previous?.lastUsableAt,
                lastVerdict: verdict,
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
            };
            return { events: [], failure: reason, sourceStates };
        };
        const response = fetched.document!;
        let posts: SteamPost[];
        try {
            posts = parseSteamNews(response.body, spec);
        } catch (error) {
            return reject("parse-error", error instanceof Error ? error.message : String(error));
        }
        if (posts.length === 0) return reject("no-update-posts", spec.noPostReason);

        // Evidence only for post instants the knowledge file has not recorded yet.
        const documentId = response.textHash;
        const claims: Claim[] = [];
        for (const post of posts) {
            const key = eventKey(game.id, topic.type, post.identity);
            if (knowledge.claims.some(c => c.eventKey === key && c.field === "at" && c.value === post.at)) continue;
            claims.push({
                id: sha(`${documentId}|${key}|at|${post.at}`).slice(0, 24),
                documentId,
                eventKey: key,
                field: "at",
                value: post.at,
                method: "deterministic",
                quote: post.excerpt,
                linkUrl: post.url,
                extractedAt: response.fetchedAt
            });
        }
        const documents: Document[] = claims.length === 0 ? [] : [{
            id: documentId,
            url: response.finalUrl,
            sourceId: source.id,
            fetchedAt: response.fetchedAt,
            title: "Steam news API response",
            fetchMode: response.mode,
            confidence: Confidence.High
        }];

        const events: EventInput[] = posts.map(p => ({ identity: p.identity, label: p.title, status: "observed", at: p.at, precision: "exact", timezone: "UTC" }));
        return {
            events,
            documents,
            claims,
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
