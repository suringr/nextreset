/**
 * Deterministic event identity.
 *
 * The same logical event must produce the same key on every run and every
 * machine, so repeated runs never create duplicates. Keys look like
 * `gta/weekly-reset/2026-09-17` or `roblox/status/2026-08-07t04-48-28z`.
 *
 * No normalization for versions, seasons or banners lives here yet; those
 * rules arrive with the trackers that need them.
 */

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export class IdentityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IdentityError";
    }
}

/**
 * Lower-case, trim, turn whitespace / colons / slashes into "-", drop any other
 * character outside [a-z0-9._-], collapse repeated dashes, trim punctuation.
 */
export function normalizeIdentity(raw: string): string {
    const normalized = raw
        .trim()
        .toLowerCase()
        .replace(/[\s:/\\]+/g, "-")
        .replace(/[^a-z0-9._-]/g, "")
        .replace(/-{2,}/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "");

    if (!SEGMENT.test(normalized)) {
        throw new IdentityError(`Cannot derive an identity segment from ${JSON.stringify(raw)}`);
    }
    return normalized;
}

/** `<game>/<topic>/<identity>`; game and topic must already be valid slugs. */
export function eventKey(game: string, topic: string, identity: string): string {
    if (!SEGMENT.test(game)) throw new IdentityError(`Invalid game segment ${JSON.stringify(game)}`);
    if (!SEGMENT.test(topic)) throw new IdentityError(`Invalid topic segment ${JSON.stringify(topic)}`);
    return `${game}/${topic}/${normalizeIdentity(identity)}`;
}

export function isEventKey(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const parts = value.split("/");
    return parts.length === 3 && parts.every(p => SEGMENT.test(p));
}

export function parseEventKey(key: string): { game: string; topic: string; identity: string } {
    if (!isEventKey(key)) throw new IdentityError(`Not an event key: ${JSON.stringify(key)}`);
    const [game, topic, identity] = key.split("/");
    return { game, topic, identity };
}

/** Identity for an exact instant: "2026-08-07T04:48:28.252Z" -> "2026-08-07t04-48-28z" (milliseconds dropped). */
export function instantIdentity(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) throw new IdentityError(`Not a date: ${JSON.stringify(iso)}`);
    return normalizeIdentity(date.toISOString().replace(/\.\d{3}Z$/, "Z"));
}

/** Identity for a UTC calendar day: "2026-09-17T10:00:00.000Z" -> "2026-09-17". */
export function dayIdentity(iso: string): string {
    const date = new Date(iso);
    if (isNaN(date.getTime())) throw new IdentityError(`Not a date: ${JSON.stringify(iso)}`);
    return date.toISOString().slice(0, 10);
}
