/**
 * Candidates that cannot answer the topic's open question, rejected before any model call.
 *
 * A topic that asks for the *next* version cannot be answered by a page about a version older
 * than the newest one already verified: League of Legends patch 26.10 notes will never say when
 * 26.20 arrives. Reading such a page costs a classify call, an extract call and sometimes a
 * relevance call, and can only ever produce "not relevant".
 *
 * The rule is deliberately narrow, because version semantics differ per game:
 *
 *   - it is opt-in per topic (`TopicDiscovery.rejectOlderVersions`), and only applies while the
 *     topic's open question needs a future event (`answeredWhen: "future-scheduled"`);
 *   - a version is only read from text that names it ("patch 26.10", "...-patch-26-10-notes"),
 *     never from a bare number, so a date or an article id is never mistaken for a version;
 *   - only *strictly older* versions are rejected. The current version is kept, because a page
 *     about it (a schedule, a hub) may well announce the next one;
 *   - when either side has no orderable version, the candidate is kept. The filter never guesses.
 *
 * Historical evidence is therefore only skipped where the question itself is about the future.
 */
import { GameKnowledge, Topic } from "../domain";

/** "patch-26-10-notes", "update-1-6-5" (URL slugs). */
const SLUG_VERSION = /(?:patch|update|version|release)(?:[-_]notes?)?[-_]v?(\d{1,4})[-_](\d{1,3})(?:[-_](\d{1,3}))?(?![\d])/i;
/** "Patch 26.10", "Version 1.6.5", "v1.6.2" (titles and labels). */
const TEXT_VERSION = /(?:patch|update|version|release|\bv)\s*\.?\s*(\d{1,4})\.(\d{1,3})(?:\.(\d{1,3}))?(?![\d.])/i;
/** A bare "26.19" label, as stored on version events. */
const BARE_VERSION = /^(\d{1,4})\.(\d{1,3})(?:\.(\d{1,3}))?$/;

function parts(match: RegExpExecArray | null): number[] | undefined {
    if (!match) return undefined;
    const numbers = match.slice(1).filter(p => p !== undefined).map(Number);
    return numbers.every(n => Number.isFinite(n)) ? numbers : undefined;
}

/** The orderable version named in a label ("Patch 26.19" or "26.19" -> [26, 19]); undefined when there is none. */
export function labelVersion(label: string | undefined): number[] | undefined {
    if (!label) return undefined;
    const trimmed = label.trim();
    return parts(BARE_VERSION.exec(trimmed)) ?? parts(TEXT_VERSION.exec(trimmed));
}

/** The version a candidate page is about, from its URL slug or its title; undefined when neither names one. */
export function candidateVersion(url: string, title?: string): number[] | undefined {
    let path = url;
    try {
        path = new URL(url).pathname;
    } catch {
        // Not a parsable URL: match against whatever text was given.
    }
    return parts(SLUG_VERSION.exec(path)) ?? parts(SLUG_VERSION.exec(url)) ?? labelVersion(title);
}

/** Numeric, segment by segment. A missing segment counts as 0, so 26.10 < 26.10.1. */
export function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

export function formatVersion(version: number[]): string {
    return version.join(".");
}

/** The newest version this topic has already verified, across published events. */
export function latestKnownVersion(knowledge: GameKnowledge, topicType: string): number[] | undefined {
    let latest: number[] | undefined;
    for (const event of knowledge.events) {
        if (event.topic !== topicType || event.publishState !== "published") continue;
        const version = labelVersion(event.label) ?? labelVersion(event.key.slice(event.key.lastIndexOf("/") + 1));
        if (version && (!latest || compareVersions(version, latest) > 0)) latest = version;
    }
    return latest;
}

function answeredWhen(topic: Topic): "future-scheduled" | "usable-source" {
    return topic.discovery?.answeredWhen ?? (topic.kind === "version" || topic.kind === "occurrence" ? "future-scheduled" : "usable-source");
}

/** Whether this topic's open question makes an older version useless (opt-in, and only for future-facing questions). */
export function rejectsOlderVersions(topic: Topic): boolean {
    return topic.discovery?.rejectOlderVersions === true && answeredWhen(topic) === "future-scheduled";
}

/** Why a page cannot answer the open question, or undefined when it might. */
export function obsoleteReason(input: { url: string; title?: string; latest: number[] | undefined }): string | undefined {
    if (!input.latest) return undefined;
    const version = candidateVersion(input.url, input.title);
    if (!version) return undefined;
    if (compareVersions(version, input.latest) >= 0) return undefined;
    return `names version ${formatVersion(version)}, older than the verified ${formatVersion(input.latest)}`;
}
