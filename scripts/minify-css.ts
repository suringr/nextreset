/**
 * Ship the stylesheet without shipping its documentation.
 *
 * `styles.v2.css` explains itself at length — why a rule exists, which bug it closes, what must not be
 * changed. That is worth keeping, and it is worth keeping out of the download: comments and indentation
 * were 40% of the file, sent to every visitor on a site whose main advantage is being fast.
 *
 * So the authored file in `public/` keeps every word, and the copy in `dist/` is stripped. This runs
 * before the asset hashes are computed, so each hash names the bytes that are actually served.
 *
 * Deliberately conservative. It removes comments, collapses whitespace, and drops the spaces either side
 * of the three characters where they can never matter — nothing else. It does not shorten colours,
 * reorder declarations, or touch the space in `and (min-width: 768px)` or inside a `content` string,
 * because the saving from those is small and the ways to get them wrong are not.
 *
 * Comments and strings are found in ONE pass, in source order. Doing it in two — strip comments, then
 * handle strings, or the reverse — gets this wrong in both directions: a comment containing an
 * apostrophe ("every page's critical CSS") opens a string that swallows the comment's terminator, and a
 * string containing slash-star opens a comment that swallows the rest of the file. Whichever construct
 * opens first is the one that is open, which is only knowable by reading left to right.
 */

/** A run of the source, labelled by what it is. */
interface Run {
    text: string;
    kind: "code" | "string" | "comment";
}

/** Splits CSS into code, string literals and comments, in source order. */
export function tokenize(css: string): Run[] {
    const runs: Run[] = [];
    let index = 0;
    let codeStart = 0;

    const flushCode = (upTo: number) => {
        if (upTo > codeStart) runs.push({ text: css.slice(codeStart, upTo), kind: "code" });
    };

    while (index < css.length) {
        const char = css[index];

        if (char === "/" && css[index + 1] === "*") {
            flushCode(index);
            const close = css.indexOf("*/", index + 2);
            const end = close < 0 ? css.length : close + 2;
            runs.push({ text: css.slice(index, end), kind: "comment" });
            index = end;
            codeStart = index;
            continue;
        }

        if (char === '"' || char === "'") {
            flushCode(index);
            let end = index + 1;
            while (end < css.length) {
                if (css[end] === "\\") { end += 2; continue; }
                if (css[end] === char) { end++; break; }
                // An unterminated string ends at the line, as CSS says it does.
                if (css[end] === "\n") break;
                end++;
            }
            runs.push({ text: css.slice(index, end), kind: "string" });
            index = end;
            codeStart = index;
            continue;
        }

        index++;
    }

    flushCode(css.length);
    return runs;
}

/** Collapses whitespace, then closes it up around the characters where it cannot carry meaning. */
function withoutSlack(code: string): string {
    return code
        .replace(/\s+/g, " ")
        .replace(/\s*([{};])\s*/g, "$1");
}

/** The stylesheet as it should be served: same rules, none of the prose. */
export function minifyCss(css: string): string {
    // Dropping a comment makes the code on either side of it contiguous, so those runs are joined
    // before anything is collapsed. Collapsing them separately leaves the blank line the comment sat
    // on as a space between two rules — which is most of what there is to save between rules.
    const merged: Run[] = [];
    for (const run of tokenize(css)) {
        if (run.kind === "comment") continue;
        const last = merged[merged.length - 1];
        if (last && last.kind === "code" && run.kind === "code") last.text += run.text;
        else merged.push({ ...run });
    }

    let out = "";
    for (const run of merged) {
        out += run.kind === "string" ? run.text : withoutSlack(run.text);
    }
    // A trailing semicolon before a closing brace is the one byte left that is never read.
    return out.replace(/;\}/g, "}").trim();
}
