/**
 * Query terms and lexical matching shared by the deterministic providers and
 * the candidate scorer. Small on purpose: exact tokens plus a plural/singular
 * tolerance; no stemming library.
 */

const STOPWORDS = new Set([
    "a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "at", "by", "with", "from", "is", "are",
    "next", "last", "latest", "new", "when", "date", "time", "release", "released", "releases", "will"
]);

/** Lower-cased word tokens of a text. */
export function tokenize(text: string): string[] {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0);
}

/** Tokens that discriminate a query: no stopwords, no single letters. */
export function significantTerms(text: string): string[] {
    const out: string[] = [];
    for (const t of tokenize(text)) {
        if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
        out.push(t);
    }
    return out;
}

function sameWord(a: string, b: string): boolean {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    return a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
}

/** How many of the terms occur among the tokens (plural-tolerant). */
export function matchedTerms(terms: string[], tokens: string[]): string[] {
    return terms.filter(term => tokens.some(token => sameWord(term, token)));
}
