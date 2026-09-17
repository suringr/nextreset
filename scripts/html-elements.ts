/**
 * Finding an element in authored HTML without depending on how it was written.
 *
 * The renderers used to locate their slots by matching an exact string — the whole element, its inner
 * text, and in one case eight leading spaces of indentation:
 *
 *     const PLACEHOLDER_LABEL = `<div class="countdown-label">Checking official sources...</div>`;
 *
 * That is why template drift throws, which is right, and it is also why the pages could not be
 * redesigned: rewording a placeholder, reordering two attributes or reformatting a line all read as
 * drift. The renderer was coupled to the markup's spelling rather than to its structure.
 *
 * This module finds an element by what it *is* — a tag carrying attributes — and reports the exact
 * source range it occupies, so callers still do surgical string replacement and can produce
 * byte-identical output. Nothing here parses the document into a tree and re-serialises it: cheerio
 * would normalise quoting, attribute order and whitespace across the whole file, which is a far larger
 * change than any renderer intends to make.
 *
 * Script, style and comment regions are masked before scanning. A `<div` inside a comment or a string
 * literal is not an element, and treating it as one works right up until someone writes a comment
 * containing markup.
 */

/** One element located in a source string. */
export interface ElementMatch {
    /** Offset of the "<" that opens the element. */
    start: number;
    /** Offset one past the ">" that closes it. */
    end: number;
    /** The whole element, exactly as it appears in the source. */
    source: string;
    /** Lower-cased tag name. */
    name: string;
    /** The opening tag, exactly as it appears. */
    openTag: string;
    /** Everything between the tags, exactly as it appears. Empty for a void or self-closed element. */
    inner: string;
    /** Attribute names lower-cased; values as written, with entities left alone. */
    attributes: Record<string, string>;
    /**
     * The indentation of the line the element opens on, when nothing else precedes it on that line.
     *
     * Multi-line replacements need this: the element's first line is already indented by the document,
     * so a replacement supplies indentation only for the lines it adds. Empty when the element does not
     * start its line, which is the honest answer — there is no indentation to reuse.
     */
    indent: string;
}

/** Elements that never have a closing tag, so an element scan must not go looking for one. */
const VOID_ELEMENTS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
]);

/**
 * Blanks out regions whose contents are not markup, preserving every offset and every line break.
 *
 * Offsets have to survive because callers slice the *original* string with them. Line breaks have to
 * survive because indentation is derived by looking back to the start of a line.
 *
 * `reveal` names raw-text elements to leave alone. A scan cannot find the `<style>` element itself if
 * style regions are masked, which is the one case where masking defeats the search rather than
 * protecting it — so a caller looking for a script or a style says so.
 */
export function maskNonMarkup(html: string, reveal: string[] = []): string {
    const blank = (text: string) => text.replace(/[^\r\n]/g, " ");
    const hidden = ["script", "style"].filter(name => !reveal.includes(name));
    let masked = html.replace(/<!--[\s\S]*?-->/g, blank);
    if (hidden.length > 0) {
        masked = masked.replace(new RegExp(`<(${hidden.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), blank);
    }
    return masked;
}

/** Reads an opening tag's attributes. Double-quoted, single-quoted, unquoted and bare are all accepted. */
export function parseAttributes(openTag: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    // Drop "<tag" and the trailing ">" before reading pairs, so the tag name is never read as an attribute.
    const body = openTag.replace(/^<\s*[A-Za-z][-A-Za-z0-9]*/, "").replace(/\/?>$/, "");
    const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of body.matchAll(pattern)) {
        attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
    return attributes;
}

/** Whether an element carries a class, as a token rather than as a substring of the attribute. */
export function hasClass(attributes: Record<string, string>, token: string): boolean {
    return (attributes.class ?? "").split(/\s+/).includes(token);
}

/** The whitespace a line begins with, or "" when the offset is not the first thing on its line. */
function indentAt(html: string, start: number): string {
    const lineStart = html.lastIndexOf("\n", start - 1) + 1;
    const before = html.slice(lineStart, start);
    return /^[ \t]*$/.test(before) ? before : "";
}

/** The offset just past the ">" that ends the tag starting at `from`, respecting quoted values. */
function endOfTag(source: string, from: number): number {
    let quote: string | undefined;
    for (let i = from; i < source.length; i++) {
        const c = source[i];
        if (quote) {
            if (c === quote) quote = undefined;
            continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === ">") return i + 1;
    }
    return -1;
}

interface OpenTag {
    start: number;
    /** Offset one past the ">" of the opening tag itself. */
    openEnd: number;
    name: string;
    source: string;
    selfClosing: boolean;
}

/** Every opening tag in the masked source, in document order. */
function scanOpenTags(masked: string): OpenTag[] {
    const tags: OpenTag[] = [];
    const pattern = /<([A-Za-z][-A-Za-z0-9]*)(?=[\s/>])/g;
    for (const match of masked.matchAll(pattern)) {
        const start = match.index!;
        const openEnd = endOfTag(masked, start);
        if (openEnd < 0) continue;
        const source = masked.slice(start, openEnd);
        const name = match[1].toLowerCase();
        tags.push({ start, openEnd, name, source, selfClosing: /\/>$/.test(source) || VOID_ELEMENTS.has(name) });
    }
    return tags;
}

/**
 * Where an element ends, counting nested elements of the same name.
 *
 * Returns -1 for an element that is never closed, so an unbalanced document costs the caller that one
 * element rather than swallowing the rest of the file.
 */
function endOfElement(masked: string, tag: OpenTag): number {
    if (tag.selfClosing) return tag.openEnd;
    const opening = new RegExp(`<${tag.name}(?=[\\s/>])`, "gi");
    const closing = new RegExp(`</${tag.name}\\s*>`, "gi");
    let depth = 1;
    let cursor = tag.openEnd;

    while (cursor < masked.length) {
        opening.lastIndex = cursor;
        closing.lastIndex = cursor;
        const nextClose = closing.exec(masked);
        if (!nextClose) return -1;
        const nextOpen = opening.exec(masked);

        if (nextOpen && nextOpen.index < nextClose.index) {
            const nestedEnd = endOfTag(masked, nextOpen.index);
            if (nestedEnd < 0) return -1;
            // A nested self-closing tag opens nothing that needs closing.
            if (!/\/>$/.test(masked.slice(nextOpen.index, nestedEnd))) depth++;
            cursor = nestedEnd;
            continue;
        }

        depth--;
        cursor = nextClose.index + nextClose[0].length;
        if (depth === 0) return cursor;
    }
    return -1;
}

/** Turns a located opening tag into a full match against the original (unmasked) source. */
function toMatch(html: string, masked: string, tag: OpenTag): ElementMatch | undefined {
    const end = endOfElement(masked, tag);
    if (end < 0) return undefined;
    const openTag = html.slice(tag.start, tag.openEnd);
    const source = html.slice(tag.start, end);
    const inner = tag.selfClosing ? "" : source.slice(openTag.length, source.lastIndexOf("</"));
    return {
        start: tag.start,
        end,
        source,
        name: tag.name,
        openTag,
        inner,
        attributes: parseAttributes(openTag),
        indent: indentAt(html, tag.start)
    };
}

/**
 * Every element the predicate accepts, in document order, nested elements included.
 *
 * The predicate sees the tag name and its attributes — enough to ask "the div with id notes" or "any
 * element carrying data-nr-slot=source" without caring how either was spelled.
 */
export function findElements(
    html: string,
    accept: (name: string, attributes: Record<string, string>) => boolean,
    reveal: string[] = []
): ElementMatch[] {
    const masked = maskNonMarkup(html, reveal);
    const found: ElementMatch[] = [];
    for (const tag of scanOpenTags(masked)) {
        if (!accept(tag.name, parseAttributes(tag.source))) continue;
        const match = toMatch(html, masked, tag);
        if (match) found.push(match);
    }
    return found;
}

/**
 * Every element with the given tag name.
 *
 * Asking for a script or a style reveals that kind, since masking it would hide the very thing being
 * looked for; the other kind stays masked.
 */
export function findByTag(html: string, tagName: string): ElementMatch[] {
    const wanted = tagName.toLowerCase();
    const reveal = wanted === "script" || wanted === "style" ? [wanted] : [];
    return findElements(html, name => name === wanted, reveal);
}

/** Every element carrying an attribute set to a given value, whatever its tag. */
export function findByAttribute(html: string, attribute: string, value: string): ElementMatch[] {
    const name = attribute.toLowerCase();
    return findElements(html, (_tag, attributes) => attributes[name] === value);
}

/** Replaces one element's source range, leaving every byte outside it untouched. */
export function spliceElement(html: string, element: ElementMatch, replacement: string): string {
    return html.slice(0, element.start) + replacement + html.slice(element.end);
}
