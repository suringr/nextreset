/**
 * Records that the data refresh failed, without stopping the publish.
 *
 * `build:site` used to swallow the refresh with `|| true`. That was half right. Publishing the rest of
 * the site when a provider — or the whole refresh — fails is correct: the pages are static, the arcade
 * works, the trackers that still have stored values still answer, and the ones that do not say so
 * honestly. Replacing all of that with nothing because one fetch failed would be worse for every
 * visitor.
 *
 * What was wrong is that `|| true` also threw away the fact that it happened. The run stayed green, so
 * a refresh that had been failing for months looked exactly like one that succeeded. Fortnite's data
 * went stale on 2026-04-05 and nothing said so until someone read the JSON.
 *
 * So the failure is recorded here instead: the chain continues, the gate reports it, and the workflow
 * turns the run red after the publish has happened. Deploy, then complain — not complain instead of
 * deploying.
 */
import * as fs from "fs";
import * as path from "path";

export const MARKER = path.resolve(__dirname, "..", "build", "refresh.failed");

/** Left for the gate to find and the workflow to act on. Cleared at the start of every refresh. */
export function markRefreshFailed(at: Date = new Date()): void {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, `${at.toISOString()}\n`, "utf8");
}

/** Removed when a refresh starts, so the marker always describes this run and not an older one. */
export function clearRefreshFailed(): void {
    if (fs.existsSync(MARKER)) fs.rmSync(MARKER, { force: true });
}

if (require.main === module) {
    markRefreshFailed();
    // Deliberately exit 0: this runs as the `||` branch of the refresh, and a non-zero exit here would
    // break the chain and stop the site publishing at all, which is the opposite of the intent.
    console.warn("::warning title=Data refresh::the refresh failed; publishing last known good values");
}
