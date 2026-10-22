/**
 * Across every game: what was published lately, and what is officially scheduled next.
 *
 * Each tracker page answers for one game. A reader who follows several wants the other view — what
 * changed this fortnight, anywhere, and what is coming that a publisher has actually announced. No
 * single publisher page gives that, and the knowledge store already holds every row of it.
 *
 * The two lists are kept apart because they are different kinds of fact:
 *   - Published: releases the trackers recorded from an official source, each linked to that source.
 *   - Officially scheduled: dates a publisher announced and has not reached yet. Nothing is projected
 *     from a rhythm, and GTA Online's weekly reset — computed from a rule — is not listed as an
 *     announcement (its row in the table above already shows the next one).
 *
 * Nothing here fetches, and nothing calls a model.
 */
import { findByAttribute, spliceElement } from "./html-elements";
import { REGION_ATTRIBUTE } from "./render-slots";
import { GameKnowledge, KnowledgeEvent, evidenceOf, publishedEvents } from "./render-data-blocks";
import { TrackerData, escapeHtml, formatDate, formatDateTime, hasVerifiedValue, isUnanswered } from "./render-pages";
import { isListed } from "./indexing";
import { trackerPages } from "./site-map";
import { gamePages } from "./update-game-pages";
import { GAMES } from "./v2/games";

const DAY_MS = 86_400_000;
/** How far back "published lately" reaches. */
export const RECENT_ACTIVITY_DAYS = 14;
/** How far ahead "officially scheduled" reaches. */
export const UPCOMING_ACTIVITY_DAYS = 30;

export interface ActivityItem {
    /** "Counter-Strike 2". */
    game: string;
    /** The tracker page, where it is worth linking to. */
    page?: string;
    /** What it was: "Counter-Strike 2 Update", "26.22". */
    label: string;
    /** The official post or page this came from. */
    source?: string;
    at: number;
    /** Formatted the way the rest of the site formats this precision. */
    when: string;
}

export interface Activity {
    published: ActivityItem[];
    scheduled: ActivityItem[];
}

export interface ActivityInput {
    read: (game: string, type: string) => TrackerData | undefined;
    knowledge: (game: string) => GameKnowledge | undefined;
    now: Date;
}

export function activityFor(input: ActivityInput): Activity {
    const nowMs = input.now.getTime();
    const published: ActivityItem[] = [];
    const scheduled: ActivityItem[] = [];
    for (const entry of trackerPages()) {
        const { game, type } = entry.tracker!;
        // A computed rule is not an announcement, and it is not a release either.
        if (entry.tracker!.computedFrom) continue;
        const knowledge = input.knowledge(game);
        if (!knowledge) continue;
        const title = gamePages.find(p => p.game === game && p.type === type)?.title ?? game;
        const page = isListed(entry.page) ? `/${game}/${type}/` : undefined;
        const data = input.read(game, type);
        // A tracker whose own page cannot answer does not get to announce its next date here either.
        const answering = hasVerifiedValue(data) && !isUnanswered(data, input.now);
        const seen = new Set<number>();
        // The same rule the tracker pages follow (sourceUrlFor in v2/views.ts): a topic whose evidence is
        // machine data — Genshin's announcement API, Mojang's manifest — sends visitors to its configured
        // human page instead of the raw JSON (Codex, #80).
        const v2Topic = GAMES.find(g => g.id === game)?.topics.find(t => t.type === type);
        const humanPage = v2Topic?.view.linkEvidence === false ? v2Topic.view.sourceUrl : undefined;
        for (const event of publishedEvents(knowledge.events, type)) {
            if (event.kind === "recurring") continue;
            const at = Date.parse(event.at!);
            if (!Number.isFinite(at)) continue;
            const evidence = evidenceOf(event, knowledge);
            // Only what the official source evidenced; a row without provenance is not ours to list.
            if (!evidence.href && !evidence.quote) continue;
            const item: ActivityItem = {
                game: title,
                ...(page ? { page } : {}),
                label: displayLabel(event.label, type),
                ...(humanPage ?? evidence.href ? { source: humanPage ?? evidence.href } : {}),
                at,
                when: event.precision === "exact" ? formatDateTime(event.at!) : formatDate(event.at!)
            };
            const end = at + (event.precision === "exact" ? 0 : DAY_MS);
            // A release is published from its own start: a day-precision release (Warzone's patch notes) is
            // published on its date, not from the midnight after it (Codex, #80). A scheduled date, by
            // contrast, stays upcoming until its whole day has passed.
            if (at <= nowMs && nowMs - at < RECENT_ACTIVITY_DAYS * DAY_MS && isRelease(event)) {
                // Two events at one instant are one release.
                if (seen.has(at)) continue;
                seen.add(at);
                published.push(item);
            } else if (end > nowMs && event.status === "scheduled" && at - nowMs <= UPCOMING_ACTIVITY_DAYS * DAY_MS && answering) {
                scheduled.push(item);
            }
        }
    }
    published.sort((a, b) => b.at - a.at || a.game.localeCompare(b.game));
    scheduled.sort((a, b) => a.at - b.at || a.game.localeCompare(b.game));
    return { published, scheduled };
}

/**
 * A stored label as a line in a list of several games.
 *
 * A bare version number ("26.22") says nothing out of its own page's context, so it is named for what it
 * is. Genshin's label carries the whole announcement, regional times included; the list keeps the
 * banner names and says the phase ends — the times for each region are on its own page.
 */
export function displayLabel(label: string, type: string): string {
    if (/^\d+(\.\d+)+$/.test(label.trim())) {
        return type.includes("release") ? `Release ${label.trim()}` : `Patch ${label.trim()}`;
    }
    const phase = /^(.*?):\s*ends\b/.exec(label);
    // The instant stored is the earliest region's; the label says which, so the time is not read as everyone's.
    if (phase) return `${phase[1].trim()}: phase ends${/\(Asia\b/.test(label) ? " (Asia servers first)" : ""}`;
    return label;
}

/**
 * Whether a past event was a release rather than a date that came and went.
 *
 * A schedule's past entries were announced, not confirmed (the patch timeline says "Past", never
 * "Released"), so a passed schedule date is not listed as published. A banner phase ending and a
 * status changing are not releases either.
 */
function isRelease(event: KnowledgeEvent): boolean {
    return event.status === "observed" && (event.kind === "version" || event.kind === "occurrence")
        && !event.topic.startsWith("next-") && event.topic !== "status";
}

function itemHtml(item: ActivityItem, indent: string): string {
    const game = item.page ? `<a href="${escapeHtml(item.page)}">${escapeHtml(item.game)}</a>` : escapeHtml(item.game);
    const label = item.source
        ? `<a href="${escapeHtml(item.source)}" target="_blank" rel="noopener">${escapeHtml(item.label)}</a>`
        : escapeHtml(item.label);
    return `${indent}<li class="data-row"><span class="data-label">${game} · ${label}</span><span class="data-when">${escapeHtml(item.when)}</span></li>`;
}

function listHtml(items: ActivityItem[], empty: string, indent: string): string {
    if (items.length === 0) return `${indent}<p class="data-note">${escapeHtml(empty)}</p>`;
    return [`${indent}<ul class="data-list">`, ...items.map(item => itemHtml(item, indent + "  ")), `${indent}</ul>`].join("\n");
}

/** The section's inner HTML. Exported so a test can read it without a page around it. */
export function activityHtml(activity: Activity, indent = "        "): string {
    return [
        `${indent}<h3>Published in the last ${RECENT_ACTIVITY_DAYS} days</h3>`,
        listHtml(activity.published, `Nothing recorded from the official sources in the last ${RECENT_ACTIVITY_DAYS} days.`, indent),
        `${indent}<h3>Officially scheduled in the next ${UPCOMING_ACTIVITY_DAYS} days</h3>`,
        listHtml(activity.scheduled, `No publisher has announced a date in the next ${UPCOMING_ACTIVITY_DAYS} days that this site has verified.`, indent)
    ].join("\n");
}

/** Writes the section into the page's declared region. A page without exactly one region throws. */
export function renderActivityHtml(html: string, activity: Activity, page = "resets/index.html"): string {
    const regions = findByAttribute(html, REGION_ATTRIBUTE, "activity");
    if (regions.length !== 1) throw new Error(`${page}: expected exactly one "activity" region, found ${regions.length}`);
    const region = regions[0];
    const eol = html.includes("\r\n") ? "\r\n" : "\n";
    const close = region.source.slice(region.source.lastIndexOf("</"));
    const body = activityHtml(activity).split("\n").join(eol);
    return spliceElement(html, region, `${region.openTag}${eol}${body}${eol}      ${close}`);
}
