/**
 * Deterministic query templates: game + topic + what is already known.
 *
 * Templates come from the topic's discovery configuration (or a default built
 * from the topic type), with placeholders:
 *   {game}    the game's name
 *   {latest}  label of the latest known event, e.g. "26.18"
 *   {next}    the version after the latest known one, e.g. "26.19"
 * Templates whose placeholders cannot be filled are skipped. Site-restricted
 * variants (one per official domain) come before the open query.
 */
import { Game, Topic } from "../domain";
import { SearchQuery } from "./search-provider";
import { normalizeDomain } from "./urls";

export interface QueryContext {
    game: Game;
    topic: Topic;
    /** Label of the latest event already known for the topic, if any. */
    latestLabel?: string;
}

/** "26.18" -> "26.19", "Patch 13.05" -> "13.06", "Update 43.1" -> "43.2"; undefined when there is no x.y number. */
export function nextVersion(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const m = /(\d+)\.(\d+)(?![\d.])/.exec(label);
    if (!m) return undefined;
    const minor = m[2];
    const next = String(Number(minor) + 1).padStart(minor.length, "0");
    return `${m[1]}.${next}`;
}

/** The x.y number inside a label ("Patch 26.18" -> "26.18"), when it has one. */
export function versionOf(label: string | undefined): string | undefined {
    if (!label) return undefined;
    const m = /(\d+\.\d+)(?![\d.])/.exec(label);
    return m ? m[1] : undefined;
}

export function defaultTemplates(topic: Topic): string[] {
    const configured = topic.discovery?.queries;
    if (configured && configured.length > 0) return configured;
    const words = topic.type.replace(/-/g, " ");
    return [`{game} ${words}`, `{game} ${words} {next}`, `{game} ${words} {latest}`];
}

export function fillTemplate(template: string, ctx: QueryContext): string | undefined {
    const values: Record<string, string | undefined> = {
        game: ctx.game.name,
        latest: versionOf(ctx.latestLabel) ?? ctx.latestLabel,
        next: nextVersion(ctx.latestLabel)
    };
    let missing = false;
    const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
        const value = values[key];
        if (value === undefined || value === "") missing = true;
        return value ?? "";
    });
    return missing ? undefined : text.replace(/\s+/g, " ").trim();
}

export interface BuiltQueries {
    /** Restricted to an official domain; used by the official channels and first on the web. */
    official: SearchQuery[];
    /** Unrestricted web queries, used only when the official ones fail. */
    open: SearchQuery[];
}

export function buildQueries(ctx: QueryContext): BuiltQueries {
    const domains = (ctx.game.discovery?.officialDomains ?? []).map(normalizeDomain).filter(d => d.length > 0);
    const texts: string[] = [];
    for (const template of defaultTemplates(ctx.topic)) {
        const text = fillTemplate(template, ctx);
        if (text && !texts.includes(text)) texts.push(text);
    }
    const official: SearchQuery[] = [];
    const open: SearchQuery[] = [];
    for (const text of texts) {
        for (const site of domains) official.push({ text, site });
        open.push({ text });
    }
    return { official, open };
}
