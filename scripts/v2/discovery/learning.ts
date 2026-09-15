/**
 * Source learning: official pages that produced accepted knowledge are stored
 * in the game's knowledge file and consulted before searching on later runs.
 *
 * Only official-tier pages are ever recorded. A secondary page may have led to
 * the official one, but it is not evidence and is not learned; the schema
 * (validate.ts) enforces the same rule at the storage boundary.
 */
import * as crypto from "crypto";
import { DiscoveredSource, DiscoveryVia, Game, GameKnowledge, Topic } from "../domain";
import { SourceTier } from "./candidates";
import { canonicalUrl } from "./urls";

export type { DiscoveryVia };

export function discoveredSourceId(topicType: string, url: string): string {
    return `${topicType}:${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

export interface LearnInput {
    url: string;
    tier: SourceTier;
    via: DiscoveryVia;
    query?: string;
    title?: string;
}

/**
 * Records that a discovered page produced accepted knowledge for a topic.
 * Returns the stored entry, or undefined (and stores nothing) for a secondary page.
 */
export function recordSourceSuccess(knowledge: GameKnowledge, topicType: string, input: LearnInput, now: Date): DiscoveredSource | undefined {
    if (input.tier !== "official") return undefined;
    const url = canonicalUrl(input.url);
    if (!url) return undefined;
    if (!knowledge.discovered) knowledge.discovered = [];
    const id = discoveredSourceId(topicType, url);
    const nowIso = now.toISOString();
    const existing = knowledge.discovered.find(d => d.id === id);
    if (existing) {
        existing.successes += 1;
        existing.lastSuccessAt = nowIso;
        if (input.title && !existing.title) existing.title = input.title;
        return existing;
    }
    const entry: DiscoveredSource = {
        id,
        url,
        topic: topicType,
        tier: "official",
        via: input.via,
        query: input.query,
        title: input.title,
        discoveredAt: nowIso,
        lastSuccessAt: nowIso,
        successes: 1,
        failures: 0
    };
    knowledge.discovered.push(entry);
    return entry;
}

/** Records a failed use of an already-learned page. Unknown pages are not added. */
export function recordSourceFailure(knowledge: GameKnowledge, topicType: string, url: string, now: Date): DiscoveredSource | undefined {
    const canonical = canonicalUrl(url);
    if (!canonical) return undefined;
    const existing = (knowledge.discovered ?? []).find(d => d.id === discoveredSourceId(topicType, canonical));
    if (!existing) return undefined;
    existing.failures += 1;
    existing.lastFailureAt = now.toISOString();
    return existing;
}

/** Learned pages for a topic, most trusted first (successes, then most recent success). */
export function learnedSourcesFor(knowledge: GameKnowledge, topicType: string): DiscoveredSource[] {
    return (knowledge.discovered ?? [])
        .filter(d => d.topic === topicType)
        .sort((a, b) => b.successes - a.successes || b.lastSuccessAt.localeCompare(a.lastSuccessAt) || a.url.localeCompare(b.url));
}

export interface KnownSource {
    url: string;
    via: "config" | "learned";
    successes: number;
    title?: string;
}

/**
 * Everything the topic can fetch without searching: its configured fetchable
 * source (if any) first, then learned pages. Rule-based sources have nothing to fetch.
 */
export function knownSourcesFor(game: Game, topic: Topic, knowledge: GameKnowledge): KnownSource[] {
    const out: KnownSource[] = [];
    const seen = new Set<string>();
    const configured = game.sources.find(s => s.id === topic.sourceId);
    if (configured && configured.kind !== "rule") {
        const url = canonicalUrl(configured.url);
        if (url) {
            out.push({ url, via: "config", successes: 0 });
            seen.add(url);
        }
    }
    for (const learned of learnedSourcesFor(knowledge, topic.type)) {
        if (seen.has(learned.url)) continue;
        seen.add(learned.url);
        out.push({ url: learned.url, via: "learned", successes: learned.successes, title: learned.title });
    }
    return out;
}
