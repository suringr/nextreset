/**
 * The approved ONE SHOT prototype, and the complete list of ways the site's copy may differ from it.
 *
 * The owner approved a game, not a description of one: `fixtures/one-shot/prototype.html` is that file,
 * exactly as it was handed over. `public/assets/one-shot.js` and the `/play/` stylesheet are that file
 * with the edits below applied and nothing else, and `one-shot.test.ts` rebuilds them from these two
 * inputs and fails on any other difference. A change to the game therefore has to be made here, where
 * it is named and explained, or it does not build.
 *
 * Every edit is one of the deviations the owner signed off:
 *   - progress kept in `nextreset.player.v1` instead of the prototype's own localStorage keys;
 *   - RELOAD fixed to take its contract's reload time and keep the crowd and the clock;
 *   - no screen shake for a visitor who has asked for reduced motion;
 *   - the shared NextReset header in place of the prototype's own, and the accessibility adaptations.
 */
import * as fs from "fs";
import * as path from "path";

export const PROTOTYPE_PATH = path.join(__dirname, "..", "..", "..", "scripts", "v2", "__tests__", "fixtures", "one-shot", "prototype.html");

export interface ApprovedEdit {
    /** Text in the prototype. It must occur exactly once, so an edit can never apply somewhere unintended. */
    from: string;
    to: string;
    why: string;
}

function prototype(): string {
    return fs.readFileSync(PROTOTYPE_PATH, "utf8").replace(/\r\n/g, "\n");
}

/** The prototype's script, exactly as written between its `<script>` tags. */
export function prototypeScript(): string {
    const html = prototype();
    const open = html.indexOf("<script>");
    const close = html.indexOf("</script>", open);
    if (open < 0 || close < 0) throw new Error("the prototype has no inline script");
    return html.slice(open + "<script>".length, close).replace(/^\n/, "").replace(/\n$/, "");
}

/** The prototype's stylesheet, with the line breaks between its rules removed — they carry nothing. */
export function prototypeCss(): string {
    const html = prototype();
    const open = html.indexOf("<style>");
    const close = html.indexOf("</style>", open);
    if (open < 0 || close < 0) throw new Error("the prototype has no inline stylesheet");
    return html.slice(open + "<style>".length, close).replace(/\n/g, "");
}

/** The prototype's on-screen hint, the one line of instructions it shows. */
export function prototypeHint(): string {
    const match = /<div id="hint">([^<]*)<\/div>/.exec(prototype());
    if (!match) throw new Error("the prototype has no hint");
    return match[1];
}

export function applyEdits(source: string, edits: ReadonlyArray<ApprovedEdit>): string {
    let out = source;
    for (const edit of edits) {
        const count = out.split(edit.from).length - 1;
        if (count !== 1) throw new Error(`an approved edit matches ${count} times, not once: ${edit.from.slice(0, 80)}`);
        out = out.replace(edit.from, () => edit.to);
    }
    return out;
}

export const SCRIPT_EDITS: ReadonlyArray<ApprovedEdit> = [
    // --- progress in nextreset.player.v1: the prototype's five storage reads and writes ---
    {
        from: "mission=Math.max(0,Math.min(79,(+localStorage.nrUnlocked||1)-1))",
        to: "mission=Math.max(0,Math.min(79,(+progress.unlocked()||1)-1))",
        why: "The contract the game resumes at: the highest unlocked, now read from the player record."
    },
    {
        from: "localStorage.nrSniperBest=Math.max(+localStorage.nrSniperBest||0,score);",
        to: "progress.finish(score);",
        why: "The score of a run through all eighty, kept where it beats the best — the prototype's nrSniperBest."
    },
    {
        from: "let xp=+localStorage.nrXP||0,rank=ranks[Math.min(8,Math.floor(xp/8000))],st=+localStorage['nrStar'+(mission+1)]||0;",
        to: "let xp=+progress.xp()||0,rank=ranks[Math.min(8,Math.floor(xp/8000))],st=+progress.stars(mission+1)||0;",
        why: "The status line's XP and the current contract's stars, read from the player record."
    },
    {
        from: "localStorage['nrStar'+(mission+1)]=Math.max(+(localStorage['nrStar'+(mission+1)]||0),stars);localStorage.nrXP=(+localStorage.nrXP||0)+pts;localStorage.nrUnlocked=Math.max(+localStorage.nrUnlocked||1,Math.min(80,mission+2));",
        to: "progress.clear(mission+1,pts,stars);",
        why: "A clear: the same three writes — best stars, XP plus the points, the next contract unlocked — as one."
    },
    {
        from: "let u=+localStorage.nrUnlocked||1",
        to: "let u=+progress.unlocked()||1",
        why: "N's contract picker offers the contracts unlocked, from the player record."
    },
    // --- RELOAD: the one gameplay change the owner approved ---
    {
        from: "if(now>msgUntil){if(state==='won')",
        to: "if(state!=='play'&&now>msgUntil){if(state==='won')",
        why: "The overlay ended the attempt for any message past its time, including RELOADING, so a reload respawned the crowd, restarted the clock and refilled at once. It now only ends a won or lost contract."
    },
    {
        from: "setTimeout(()=>{if(reloading)message=''},500)",
        to: "setTimeout(()=>{if(reloading&&message==='RELOADING')message=''},500)",
        why: "With the reload now taking its time, the contract can be lost during it. Clearing whatever message was up would erase TIME UP or YOU WERE SHOT and leave the game stuck; this clears only its own."
    },
    // --- reduced motion ---
    {
        from: "if(shake){ctx.translate(",
        to: "if(shake){if(!calm.matches)ctx.translate(",
        why: "No screen shake for a visitor who has asked for reduced motion. Everything else about the shot is unchanged."
    }
];

export const CSS_EDITS: ReadonlyArray<ApprovedEdit> = [
    {
        from: "header{height:52px;flex:0 0 52px;",
        to: "header{min-height:52px;flex:0 0 auto;",
        why: "The bar is now the shared header, which takes a second row on a phone when the player chip shows. A fixed height would cut the chip off."
    },
    {
        from: ".brand{font-size:22px;font-weight:850}.brand span{color:#38cfff}.sub,#best{font-size:12px;color:#9babb8}",
        to: ".chrome-title{font-size:12px;font-weight:850;color:#38cfff}#best{position:fixed;left:14px;bottom:34px;font-size:12px;color:#9babb8;pointer-events:none}",
        why: "The site's wordmark replaces the prototype's. Its subtitle becomes the page's h1 in the shared header, with the look it had inside the wordmark. The detailed status line leaves the header — the header shows a compact chip — and sits over the game above the hint, where the prototype already puts text."
    },
    {
        from: "@media(max-width:700px){header{height:44px;flex-basis:44px}.brand{font-size:18px}.sub{display:none}",
        to: "@media(max-width:700px){header{min-height:44px}.chrome-title{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}#best{bottom:14px}",
        why: "The same header on a phone. The subtitle is hidden there as in the prototype, but only from sight, because it is the page's h1. The hint is hidden on a phone, so the status line takes its place."
    }
];

/** The on-screen hint: RELOAD no longer restarts the contract, so the line that said it would does not either. */
export const HINT_EDIT: ApprovedEdit = {
    from: "R to restart",
    to: "R to reload",
    why: "Part of the RELOAD fix. The prototype's R did restart the contract — that was the bug — and now it reloads."
};
