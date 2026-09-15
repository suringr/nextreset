/**
 * Discovery cadence: how often a topic may search for new sources.
 *
 * Known sources are re-checked on every refresh run; that is cheap (conditional
 * requests, and an unchanged document stops before any model call). Discovery
 * (sitemaps, listings, web search, and the model calls on what it finds) runs at
 * most once per `minIntervalHours` (default 24) per topic, except when a sooner
 * search is justified:
 *
 *   - the topic has held evidence waiting for confirmation;
 *   - a scheduled event of the topic has passed since the last search, so the
 *     open question itself changed (the next patch is now unknown).
 *
 * A topic whose schedule needs faster checks (maintenance, downtime) sets a
 * lower `minIntervalHours` in its configuration. Recurring and structured
 * topics never discover at all.
 */
import { GameKnowledge, Topic, TopicState } from "../domain";
import { eventsForTopic, upcomingUntil } from "../knowledge";

export const DEFAULT_DISCOVERY_INTERVAL_HOURS = 24;

const HOUR_MS = 3_600_000;

export function topicStateFor(knowledge: GameKnowledge, topicType: string): TopicState | undefined {
    return (knowledge.topicStates ?? []).find(s => s.topic === topicType);
}

export function discoveryDue(input: { topic: Topic; knowledge: GameKnowledge; now: Date }): { due: boolean; reason: string } {
    const { topic, knowledge, now } = input;
    const hours = topic.discovery?.minIntervalHours ?? DEFAULT_DISCOVERY_INTERVAL_HOURS;
    const lastIso = topicStateFor(knowledge, topic.type)?.lastDiscoveryAt;
    const last = lastIso ? Date.parse(lastIso) : NaN;
    if (isNaN(last)) return { due: true, reason: "discovery has not run for this topic yet" };

    const nextAt = last + hours * HOUR_MS;
    if (now.getTime() >= nextAt) return { due: true, reason: `the last discovery (${lastIso}) is at least ${hours} h old` };

    const events = eventsForTopic(knowledge, topic.type);
    if (events.some(e => e.publishState === "held")) return { due: true, reason: "held evidence is waiting for confirmation" };

    const passed = events.find(e => {
        if (e.status === "observed") return false;
        const until = upcomingUntil(e);
        return until !== undefined && until > last && until <= now.getTime();
    });
    if (passed) return { due: true, reason: `${passed.label} passed after the last discovery, so the open question changed` };

    return { due: false, reason: `discovery last ran at ${lastIso}; the next regular search is after ${new Date(nextAt).toISOString()} (every ${hours} h)` };
}
