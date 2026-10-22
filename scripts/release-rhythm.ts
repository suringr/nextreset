/**
 * What a game's recorded history says about how often it changes, as plain facts.
 *
 * The knowledge store holds every release each tracker has read, with its date and the official post it
 * came from. A reader who opens a tracker page wants to know more than the last date: how long ago that
 * was, how often this game has been updating, whether the gap they are sitting in is unusual. The
 * publisher's own page does not answer that; the history the build already holds does.
 *
 * Everything here is arithmetic on stored events, at build time. Nothing fetches, nothing calls a model.
 *
 * What it refuses to do:
 *   - forecast. No "next expected", no "overdue". A gap is reported as what it was.
 *   - present partial history as complete. Every figure is stated with the count it was taken from and
 *     the date the record starts.
 *   - state a rhythm from too little. "How often" is `cadenceOf`, the same function /resets/ uses, so a
 *     tracker page and the hub cannot publish two different answers; where it finds no rhythm, the page
 *     says so.
 *   - count a duplicate twice, or mix two series. Two events at the same instant are one release, and a
 *     tracker that follows two title years (EA SPORTS FC 26 and 27) is measured within the newest one.
 *   - drift with daylight saving. Gaps are counted in UTC calendar days.
 */
import { Block, BlockOptions, BlockRow, GameKnowledge, KnowledgeEvent, publishedEvents } from "./render-data-blocks";

const DAY_MS = 86_400_000;

/**
 * How many of the most recent intervals decide what "how often" says.
 *
 * Ten is roughly five months of a fortnightly game and two and a half of a weekly one: long enough
 * that one odd interval cannot invent or destroy a rhythm, short enough that the answer describes what
 * the game is doing now rather than what it did two years ago.
 */
export const RECENT_GAPS = 10;

/**
 * How often a tracker comes round, in words, or undefined where saying would be a guess.
 *
 * Two honest sources and no third. A recurring topic states its rule — Rockstar publishes GTA's, and
 * the adapter computes from it — and that rule is quotable as it stands. Everything else can only be
 * observed: if a game's published history is evenly spaced, the spacing is a fact about the history and
 * is worth reporting as "about every N", hedged because it describes what has happened rather than a
 * promise. Where the gaps are uneven — Valve ships Counter-Strike updates when they are ready — there
 * is no cadence to report, and the column stays empty rather than inventing a rhythm.
 */
export function cadenceOf(knowledge: GameKnowledge | undefined, topic: string, rule?: string, now?: Date): string | undefined {
    if (rule) return rule;
    const events = publishedEvents(knowledge?.events, topic)
        .map((event: KnowledgeEvent) => (event.at ? Date.parse(event.at) : NaN))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    // Four events is three gaps: enough for "evenly spaced" to mean something rather than describing a
    // single interval twice. Fewer, and there is nothing to be consistent about.
    if (events.length < 4) return undefined;
    // The recent window, not the whole history.
    //
    // "How often" is a claim about now, and judging it on everything a game has ever done gets both
    // ends wrong. A hiatus in 2024 followed by two years of weekly releases is a weekly game, and a
    // rule that remembers the hiatus forever would never say so. Four weekly releases followed by a
    // two-year silence and one more release is not a weekly game, however tidy those four gaps were.
    // Looking at the last few gaps answers both: the hiatus falls out of the window once the rhythm
    // has resumed, and the two-year gap is still in it.
    const allGaps = events.slice(1).map((at, index) => at - events[index]);
    const gaps = allGaps.slice(-RECENT_GAPS);
    if (gaps.length < 3) return undefined;
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median <= 0) return undefined;
    // Most gaps close to the median, rather than all of them.
    //
    // This is a test of whether a rhythm is there to report, not a bar a game has to clear to deserve
    // something. League of Legends is the case that sets it: twenty-three gaps, twenty-one of them
    // thirteen to fifteen days, and two of twenty-one where a split break falls. Demanding that every
    // gap agree would throw away a two-week cycle that genuinely exists, because Riot takes Christmas
    // off. Allowing a quarter of them to disagree keeps that and still rejects Counter-Strike, where
    // Valve ships twice in a day and then not for a month and there is no rhythm to find.
    // Strictly below, so that a quarter disagreeing is allowed rather than only fewer than a quarter —
    // which is what the sentence above says, and what `<=` quietly did not do. With four intervals,
    // three fortnights and one split break is exactly 0.75, and is a fortnightly game.
    const close = gaps.filter(gap => Math.abs(gap - median) <= median * 0.25).length;
    if (close / gaps.length < 0.75) return undefined;
    // A break is a break; an abandonment is not a rhythm. The ratio alone cannot tell them apart —
    // four weekly gaps and then a two-year silence is four fifths "close to the median", and would
    // have been published as "About weekly" for a game nobody has updated since. An outlier may be
    // twice the median, which covers Riot's split breaks, and not more. Within the recent window, so
    // an old hiatus stops counting against a game that has since resumed.
    if (gaps.some(gap => gap > median * 2)) return undefined;
    // And the rhythm has to still be running. "How often" is a claim in the present tense, so a
    // history that stopped longer ago than the rhythm itself no longer describes anything current.
    const last = events[events.length - 1];
    if (now && now.getTime() - last > median * 2) return undefined;
    const days = Math.round(median / DAY_MS);
    if (days < 1) return undefined;
    if (days === 1) return "About daily";
    if (days === 7) return "About weekly";
    if (days % 7 === 0) return `About every ${days / 7} weeks`;
    return `About every ${days} days`;
}


/** Gaps listed on the page, newest first. Enough to see a pattern; more is a wall of numbers. */
export const RECENT_GAPS_SHOWN = 10;
/** The window "in the last N days" counts over. */
export const RECENT_WINDOW_DAYS = 90;

/** Midnight UTC of the day an instant falls on. */
function utcDay(ms: number): number {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Whole UTC calendar days from one instant to another. Daylight saving does not exist in UTC. */
export function utcDaysBetween(from: number, to: number): number {
    return Math.round((utcDay(to) - utcDay(from)) / DAY_MS);
}

/**
 * The series an event belongs to, where a tracker follows more than one.
 *
 * EA SPORTS FC's identities are prefixed by title year ("fc26-1.6.5", "fc27-1.0.4"); the two years
 * overlap and are separate games, so a gap from an FC 26 patch to an FC 27 one measures nothing. An
 * identity without such a prefix is one series.
 */
export function seriesOf(event: KnowledgeEvent): string | undefined {
    const identity = event.key.split("/").pop() ?? "";
    return /^([a-z]+\d+)-/.exec(identity)?.[1];
}

/** What a tracker counts, in the words its page uses. */
export function subjectFor(type: string): { plural: string; singular: string } | undefined {
    if (type === "last-update") return { plural: "updates", singular: "update" };
    if (type === "last-patch") return { plural: "patches", singular: "patch" };
    if (type === "last-release") return { plural: "releases", singular: "release" };
    if (type === "last-title-update") return { plural: "title updates", singular: "title update" };
    return undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const days = (n: number) => (n === 0 ? "same day" : plural(n, "day", "days"));

/** Instants, oldest first, one per release: two events at one instant are one release. */
function distinctInstants(events: KnowledgeEvent[]): number[] {
    const instants = events.map(e => Date.parse(e.at!)).filter(Number.isFinite).sort((a, b) => a - b);
    return instants.filter((at, i) => i === 0 || at !== instants[i - 1]);
}

function gapsOf(instants: number[]): number[] {
    return instants.slice(1).map((at, i) => utcDaysBetween(instants[i], at));
}

export interface RhythmOptions extends BlockOptions {
    /** The answer /resets/ gives for this tracker, or undefined where it gives none. */
    cadence?: string;
    /** Whether an event carries a link or quote to its official source; only those are counted. */
    evidenced: (event: KnowledgeEvent) => boolean;
}

/**
 * A release feed in numbers: when the last recorded release was, how many there have been lately, how
 * often (as /resets/ says), and the gaps themselves. Undefined where there are fewer than two releases.
 */
export function releaseRhythm(knowledge: GameKnowledge | undefined, topic: string, type: string, options: RhythmOptions): Block | undefined {
    const subject = subjectFor(type);
    if (!knowledge || !subject) return undefined;
    const nowMs = options.now.getTime();
    // Releases that have happened and that the official source evidenced — the same rows the history
    // list shows, plus the headline's own. Held events and future timestamps are not releases yet.
    let events = publishedEvents(knowledge.events, topic).filter(e => Date.parse(e.at!) <= nowMs && options.evidenced(e));
    if (events.length === 0) return undefined;
    // Whether "how often" had enough to judge is a question about what cadenceOf saw — every published
    // event of the topic, both title years included — not about the one series the gaps below describe.
    const judged = distinctInstants(publishedEvents(knowledge.events, topic)).length;
    const newest = [...events].sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0];
    const series = seriesOf(newest);
    if (series) events = events.filter(e => seriesOf(e) === series);

    const instants = distinctInstants(events);
    if (instants.length < 2) return undefined;
    const gaps = gapsOf(instants);
    const first = instants[0];
    const last = instants[instants.length - 1];
    const sinceLast = utcDaysBetween(last, nowMs);
    const recent = instants.filter(at => utcDaysBetween(at, nowMs) < RECENT_WINDOW_DAYS).length;
    // cadenceOf needs four events (three gaps) before it will call anything a rhythm.
    const enough = judged >= 4;
    const firstDate = options.format(new Date(first).toISOString());
    // "fc27" reads as "FC 27": the series is named the way the publisher names the title year.
    const seriesName = series?.replace(/^([a-z]+)(\d+)$/, (_, letters: string, digits: string) => `${letters.toUpperCase()} ${digits}`);
    const seriesWord = seriesName ? ` of ${seriesName}` : "";

    const rows: BlockRow[] = [
        { label: `Last recorded ${subject.singular}`, when: sinceLast === 0 ? "Today" : `${plural(sinceLast, "day", "days")} ago, on ${options.format(new Date(last).toISOString())}` },
        { label: `In the last ${RECENT_WINDOW_DAYS} days`, when: plural(recent, subject.singular, subject.plural) },
        {
            label: "How often",
            when: options.cadence ?? (enough
                ? "No regular rhythm in the recorded history"
                : `Too few recorded to tell (${judged} so far)`)
        },
        { label: "Shortest gap", when: days(Math.min(...gaps)) },
        { label: "Longest gap", when: days(Math.max(...gaps)) },
        { label: "Recent gaps, newest first", when: gaps.slice(-RECENT_GAPS_SHOWN).reverse().map(g => (g === 0 ? "0" : String(g))).join(", ") + " days" },
        { label: "Counted from", when: `${plural(instants.length, subject.singular, subject.plural)}${seriesWord} recorded since ${firstDate}` }
    ];
    return {
        title: `${capitalize(subject.plural)} in numbers`,
        note: `Counted from the ${subject.plural} this tracker has recorded from the official source. The record starts on ${firstDate}; anything earlier is not counted. These figures describe what has happened, not when the next one will come.`,
        rows
    };
}

/**
 * A published schedule in numbers: how far away the next date is, how often (as /resets/ says), and the
 * gaps between the dates the publisher has announced. A past date is a date that was announced, not a
 * release anybody confirmed, and the note says so.
 */
export function scheduleRhythm(knowledge: GameKnowledge | undefined, topic: string, options: RhythmOptions): Block | undefined {
    if (!knowledge) return undefined;
    const nowMs = options.now.getTime();
    const events = publishedEvents(knowledge.events, topic).sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!));
    const instants = distinctInstants(events);
    if (instants.length < 4) return undefined;
    const gaps = gapsOf(instants);
    const rows: BlockRow[] = [];
    const next = options.headlineAnswered !== false && options.currentKey ? events.find(e => e.key === options.currentKey) : undefined;
    if (next && Date.parse(next.at!) + (next.precision === "exact" ? 0 : DAY_MS) > nowMs) {
        const until = utcDaysBetween(nowMs, Date.parse(next.at!));
        rows.push({ label: "Next scheduled", when: `${next.label}, ${until <= 0 ? "today" : `in ${plural(until, "day", "days")}`} (${options.format(next.at!, next.precision)})` });
    }
    rows.push(
        { label: "How often", when: options.cadence ?? "No regular rhythm on the published schedule" },
        { label: "Shortest gap", when: days(Math.min(...gaps)) },
        { label: "Longest gap", when: days(Math.max(...gaps)) },
        { label: "Gaps on the schedule, latest first", when: gaps.slice(-RECENT_GAPS_SHOWN).reverse().join(", ") + " days" },
        { label: "Counted from", when: `${instants.length} dates, ${options.format(new Date(instants[0]).toISOString())} to ${options.format(new Date(instants[instants.length - 1]).toISOString())}` }
    );
    return {
        title: "The schedule in numbers",
        note: "Gaps between the dates on the publisher's schedule. A schedule can change, and a past entry on it records the date that was announced, not a confirmed release.",
        rows
    };
}

function capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
