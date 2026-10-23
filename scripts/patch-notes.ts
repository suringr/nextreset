/**
 * What an update's own notes list, read from the post as stored: section headings and how many changes
 * each lists. A pilot for Counter-Strike 2.
 *
 * Valve's update posts are BBCode with a fixed shape: a paragraph holding only "[ NAME ]" opens a
 * section, and each change is a list item ("[*]"). Checked on the twenty most recent posts on 22 October
 * 2026: every "Counter-Strike 2 Update" post had headings, and for every one of them the per-section
 * counts added up to the post's total list items. That is what makes this safe to publish.
 *
 * What it refuses:
 *   - a partial read. Steam was asked for 240 characters of each post until this pilot; a stored excerpt
 *     cut there is not the notes, and a count from it would be wrong. Only a post stored from a response
 *     that asked for whole posts (maxlength=0) is read, and anything else shows nothing.
 *   - a guess. A post with no headings, items outside every heading, or a heading with nothing under it
 *     is not summarised at all, rather than summarised wrongly.
 *   - copying the notes. Headings and counts only; the notes themselves stay on Steam, one link away.
 *
 * Nothing here fetches, and nothing calls a model: it reads evidence the knowledge store already holds.
 */
import { GameKnowledge, KnowledgeEvent } from "./render-data-blocks";

export interface NoteSection {
    /** As Valve writes it, in title case: "Map scripting", "UI". */
    name: string;
    /** List items under the heading. */
    items: number;
}

/** Trackers whose notes are summarised. A pilot: Counter-Strike 2 only. */
export const SECTIONED_NOTES = new Set(["cs2/last-update"]);

const HEADING = /\[p\]\s*\\?\[\s*([A-Za-z][A-Za-z0-9 &'/.-]{0,38}?)\s*\]\s*\[\/p\]/g;

function titleCase(heading: string): string {
    const words = heading.trim().split(/\s+/);
    // Short all-caps words are acronyms ("UI"); everything else reads as a word, not as shouting.
    if (words.length === 1 && words[0].length <= 3) return words[0].toUpperCase();
    const text = words.join(" ").toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The changes a section lists: items of its own lists, not the steps nested under one of them.
 *
 * Valve sometimes explains a change with a list inside its item — the 22 September 2026 post describes
 * the new map selection in seven nested steps. Those are one change, not eight (Codex, #81). Undefined
 * where the lists do not balance, or an item stands outside any list: a shape this cannot count.
 */
export function topLevelItems(body: string): number | undefined {
    let depth = 0;
    let items = 0;
    for (const token of body.matchAll(/\[(\/?)(o?list)\b[^\]]*\]|\[\*\]/gi)) {
        if (token[0] === "[*]") {
            if (depth === 0) return undefined;
            if (depth === 1) items++;
            continue;
        }
        depth += token[1] ? -1 : 1;
        if (depth < 0) return undefined;
    }
    return depth === 0 ? items : undefined;
}

/** The sections of one post's BBCode, or undefined where its shape is not one this can count honestly. */
export function sectionsOf(contents: string): NoteSection[] | undefined {
    const marks = [...contents.matchAll(HEADING)].map(m => ({ name: m[1], start: m.index!, end: m.index! + m[0].length }));
    if (marks.length === 0) return undefined;
    // Items before the first heading belong to no section; a count would have to drop or invent one.
    if (/\[\*\]/.test(contents.slice(0, marks[0].start))) return undefined;
    const sections: NoteSection[] = [];
    for (let i = 0; i < marks.length; i++) {
        const body = contents.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : contents.length);
        const items = topLevelItems(body);
        if (items === undefined || items === 0) return undefined;
        sections.push({ name: titleCase(marks[i].name), items });
    }
    return sections;
}

/** Whether a stored response asked Steam for whole posts rather than excerpts. */
export function isWholePostRead(url: string): boolean {
    try {
        return new URL(url).searchParams.get("maxlength") === "0";
    } catch {
        return false;
    }
}

/**
 * The sections of an event's notes, from its newest claim stored from a whole-post read. Undefined where
 * there is none, or where that post's shape cannot be counted.
 */
export function noteSectionsFor(event: KnowledgeEvent, knowledge: GameKnowledge): NoteSection[] | undefined {
    if (!SECTIONED_NOTES.has(`${knowledge.game}/${event.topic}`)) return undefined;
    const claims = (knowledge.claims ?? [])
        .filter(c => c.eventKey === event.key && c.quote)
        .sort((a, b) => (b.extractedAt ?? "").localeCompare(a.extractedAt ?? ""));
    for (const claim of claims) {
        const document = (knowledge.documents ?? []).find(d => d.id === claim.documentId);
        if (!document || !isWholePostRead(document.url)) continue;
        let post: unknown;
        try {
            post = JSON.parse(claim.quote!);
        } catch {
            continue;
        }
        const contents = (post as { contents?: unknown })?.contents;
        if (typeof contents !== "string") continue;
        return sectionsOf(contents);
    }
    return undefined;
}

/** "UI 4 · Misc 5": the sections in the order Valve wrote them. */
export function sectionsLine(sections: NoteSection[]): string {
    return sections.map(s => `${s.name} ${s.items}`).join(" · ");
}

export function changesCount(sections: NoteSection[]): number {
    return sections.reduce((sum, s) => sum + s.items, 0);
}
