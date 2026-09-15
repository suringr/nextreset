/**
 * Steam news posts as events (structured JSON source, deterministic parse).
 *
 * Source: the Steam Web API news endpoint for one or more apps, restricted to the
 * publisher's own community announcements. A spec decides which posts are
 * events (a whole-title pattern, optionally a required tag) and what identifies
 * one (Steam's post id, or a version captured from the title, optionally prefixed
 * per feed such as "fc26-").
 *
 * Each accepted post becomes one observed event at its publication time, exact
 * to the second. That is when the publisher announced it, which can differ
 * slightly from when the change went live.
 *
 * Evidence names what was fetched: the document is the API response (its URL
 * and content hash), and each claim quotes its post exactly as it appears in
 * that response. The claim also carries Steam's own link for the post, which
 * becomes the published `source_url`. Evidence is recorded only for post
 * instants that are new to the knowledge file.
 *
 * Several feeds: posts from every feed are combined, so the newest post across
 * them is published (for EA SPORTS FC, the previous title year's last update
 * until the new year's first one). Requests then carry no conditional headers,
 * because every feed's body is needed together; change is detected by text hash.
 *
 * No model is involved. A response that is not the news shape, or feeds that
 * together hold no accepted post, keep the last good hashes and are reported
 * stale, so a title format change by the publisher is visible.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter, AdapterContext, AdapterOutcome, EventInput } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
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
    /** Prepended to the identity (for example "fc26-"), so identities from different feeds never collide. */
    identityPrefix?: string;
    /** Link used when a post carries no https link of its own. */
    fallbackUrl: string;
    /** Failure reason when a valid response holds no accepted post. */
    noPostReason: string;
}

export interface SteamNewsFeed {
    /** The game source (see games.ts) this feed is fetched from. */
    sourceId: string;
    spec: SteamNewsSpec;
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
        const raw = spec.identity === "gid" ? item.gid : match[1];
        const excerpt = quotes.get(item.gid);
        if (!raw || !excerpt) continue;
        posts.push({
            gid: item.gid,
            title,
            date: item.date,
            at: new Date(item.date * 1000).toISOString(),
            url: typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : spec.fallbackUrl,
            identity: `${spec.identityPrefix ?? ""}${raw}`,
            excerpt
        });
    }
    return firstPublications(posts);
}

/** One post per identity (the earliest publication wins), newest first (ties: higher post id first). */
function firstPublications(posts: SteamPost[]): SteamPost[] {
    const sorted = [...posts].sort((a, b) => a.date - b.date || (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0));
    const seen = new Set<string>();
    const unique = sorted.filter(p => {
        if (seen.has(p.identity)) return false;
        seen.add(p.identity);
        return true;
    });
    return unique.reverse();
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

async function runFeeds(ctx: AdapterContext, feeds: SteamNewsFeed[], transport: Transport | undefined): Promise<AdapterOutcome> {
    const { game, topic, now, getSourceState, knowledge } = ctx;
    // With several feeds every body is needed together, so no conditional headers (a 304 carries no body).
    const conditional = feeds.length === 1;
    const sourceStates: SourceState[] = [];
    const responses: Array<{ feed: SteamNewsFeed; document: FetchedDocument; previousHash?: string; previousUsableAt?: string; previousFailures: number }> = [];
    let unchangedCount = 0;
    let httpStatus = 304;
    let mode: "http" | "browser" = "http";
    for (const feed of feeds) {
        const source = game.sources.find(s => s.id === feed.sourceId);
        if (!source) throw new Error(`Source ${feed.sourceId} is not configured for ${game.id}`);
        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const matching = stored && stored.url === source.url ? stored : undefined;
        const previous = matching && !conditional ? { ...matching, etag: undefined, lastModified: undefined } : matching;
        const fetched = await smartFetch(source.url, { expect: { kind: "json" }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}`, now });
        const state: SourceState = { id: source.id, url: source.url, ...fetched.state, ...(conditional ? {} : { etag: undefined, lastModified: undefined }) };
        sourceStates.push(state);
        if (fetched.outcome === "unusable") {
            return { events: [], failure: `${feeds.length > 1 ? `${source.id}: ` : ""}${fetched.error ?? fetched.verdict?.reason ?? "fetch failed"}`, sourceStates };
        }
        if (fetched.outcome === "unchanged") unchangedCount++;
        if (fetched.document) {
            httpStatus = fetched.document.status;
            mode = fetched.document.mode;
            responses.push({ feed, document: fetched.document, previousHash: matching?.textHash, previousUsableAt: matching?.lastUsableAt, previousFailures: matching?.consecutiveFailures ?? 0 });
        }
    }
    const fetch = { httpStatus, mode };
    if (unchangedCount === feeds.length) {
        return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: unchangedCount, deterministic: 0, sentToAi: 0, deferred: 0 } };
    }

    // Content that cannot be trusted is a source failure. Keep every feed's last good hash and drop validators, so the
    // same content is examined again next run instead of reading as "unchanged, still good".
    const reject = (verdict: string, reason: string): AdapterOutcome => {
        for (let i = 0; i < sourceStates.length; i++) {
            const response = responses.find(r => r.feed.sourceId === sourceStates[i].id);
            sourceStates[i] = {
                ...sourceStates[i],
                etag: undefined,
                lastModified: undefined,
                textHash: response?.previousHash,
                lastUsableAt: response?.previousUsableAt,
                lastVerdict: verdict,
                consecutiveFailures: (response?.previousFailures ?? 0) + 1
            };
        }
        return { events: [], failure: reason, sourceStates };
    };

    const parsed: Array<{ document: FetchedDocument; posts: SteamPost[] }> = [];
    for (const response of responses) {
        try {
            parsed.push({ document: response.document, posts: parseSteamNews(response.document.body, response.feed.spec) });
        } catch (error) {
            return reject("parse-error", `${feeds.length > 1 ? `${response.feed.sourceId}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const posts = firstPublications(parsed.flatMap(p => p.posts));
    if (posts.length === 0) return reject("no-update-posts", feeds[0].spec.noPostReason);

    // A post whose identity is already stored with an earlier instant is a re-post: the stored first publication
    // stands (the original may have rolled out of the feed), and the re-post adds no evidence.
    const instantOf = (post: SteamPost): string => {
        const storedAt = knowledge.events.find(e => e.key === eventKey(game.id, topic.type, post.identity))?.at;
        return storedAt !== undefined && Date.parse(storedAt) < Date.parse(post.at) ? storedAt : post.at;
    };

    // Evidence only for post instants the knowledge file has not recorded yet, each tied to the response it came from.
    const claims: Claim[] = [];
    const documents: Document[] = [];
    for (const { document, posts: feedPosts } of parsed) {
        const feedSourceId = responses.find(r => r.document === document)!.feed.sourceId;
        let added = 0;
        for (const post of feedPosts) {
            if (!posts.includes(post)) continue;
            const key = eventKey(game.id, topic.type, post.identity);
            if (instantOf(post) !== post.at) continue;
            if (knowledge.claims.some(c => c.eventKey === key && c.field === "at" && c.value === post.at)) continue;
            claims.push({
                id: sha(`${document.textHash}|${key}|at|${post.at}`).slice(0, 24),
                documentId: document.textHash,
                eventKey: key,
                field: "at",
                value: post.at,
                method: "deterministic",
                quote: post.excerpt,
                linkUrl: post.url,
                extractedAt: document.fetchedAt
            });
            added++;
        }
        if (added > 0) {
            documents.push({ id: document.textHash, url: document.finalUrl, sourceId: feedSourceId, fetchedAt: document.fetchedAt, title: "Steam news API response", fetchMode: document.mode, confidence: Confidence.High });
        }
    }

    const events: EventInput[] = posts.map(p => ({ identity: p.identity, label: p.title, status: "observed", at: instantOf(p), precision: "exact", timezone: "UTC" }));
    return {
        events,
        documents,
        claims,
        confidence: Confidence.High,
        sourceStates,
        fetch,
        // Structured JSON parsed by code: never sent to a model.
        work: { unchanged: unchangedCount, deterministic: feeds.length - unchangedCount, sentToAi: 0, deferred: 0 }
    };
}

/** One feed, fetched from the topic's own source (conditional requests allowed). */
export function createSteamNewsAdapter(spec: SteamNewsSpec, transport?: Transport): Adapter {
    return async (ctx) => runFeeds(ctx, [{ sourceId: ctx.topic.sourceId, spec }], transport);
}

/** Several feeds combined into one topic, for example one Steam app per title year. */
export function createSteamNewsFeedsAdapter(feeds: SteamNewsFeed[], transport?: Transport): Adapter {
    if (feeds.length === 0) throw new Error("createSteamNewsFeedsAdapter needs at least one feed");
    return async (ctx) => runFeeds(ctx, feeds, transport);
}
