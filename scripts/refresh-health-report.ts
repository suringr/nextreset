/**
 * Turns this run's provider health into one line the workflow can act on.
 *
 * Printed as `degraded=<n>` for `$GITHUB_OUTPUT`, plus an annotation naming each provider so the run
 * page says what is wrong rather than only that something is. Counting only the degradation nobody has
 * accepted — see `unexpectedlyDegraded` — so a known stop does not hold the run red for ever and drown
 * out the next real regression.
 *
 * Exits 0 whatever it finds. Deciding what a degraded run *means* is the workflow's job; this only
 * reports, and a reporter that can fail the step it reports from is a reporter that hides its subject.
 */
import { readHealth, unexpectedlyDegraded } from "./refresh-health";

if (require.main === module) {
    const health = readHealth();
    if (!health) {
        // No health file: either the refresh never ran or it died before writing one. The separate
        // `refresh.failed` marker covers the second case, so this is not an error on its own.
        console.log("degraded=0");
        process.exit(0);
    }
    const unexpected = unexpectedlyDegraded(health);
    for (const provider of unexpected) {
        const detail = provider.detail ? `: ${provider.detail}` : "";
        console.log(`::warning title=Provider degraded::${provider.game}/${provider.type} is ${provider.status} and its page is still offered to readers${detail}`);
    }
    console.log(`degraded=${unexpected.length}`);
}
