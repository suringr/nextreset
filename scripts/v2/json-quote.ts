/**
 * Verbatim quotes from JSON responses.
 *
 * Evidence must quote what was fetched. A fact taken from a structured
 * response is supported by the exact slice of the response text that holds it,
 * not by fields re-serialized afterwards, so the quote can be checked against
 * the stored document hash.
 *
 * The scanner tracks JSON strings, so braces inside string values (post
 * bodies, titles) never break an object's boundaries.
 */

/** Every object in a JSON text as [start, end) offsets. Malformed or unbalanced input gives no spans. */
export function jsonObjectSpans(text: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const stack: number[] = [];
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") i++; // skip the escaped character
            else if (ch === "\"") inString = false;
            continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "{") stack.push(i);
        else if (ch === "}") {
            const start = stack.pop();
            if (start === undefined) return [];
            spans.push([start, i + 1]);
        }
    }
    return stack.length === 0 && !inString ? spans : [];
}

/**
 * The verbatim text of every object whose `key` is a string, indexed by that value (the first occurrence wins).
 * Each slice parses back to exactly the object it was taken from.
 */
export function indexJsonObjects(text: string, key: string): Map<string, string> {
    const index = new Map<string, string>();
    for (const [start, end] of jsonObjectSpans(text)) {
        const slice = text.slice(start, end);
        let parsed: unknown;
        try {
            parsed = JSON.parse(slice);
        } catch {
            continue;
        }
        const value = (parsed as Record<string, unknown> | null)?.[key];
        if (typeof value === "string" && !index.has(value)) index.set(value, slice);
    }
    return index;
}
