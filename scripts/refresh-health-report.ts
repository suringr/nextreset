/**
 * Turns this run's provider health into one line the workflow can act on.
 *
 * Two streams, on purpose. `degraded=<n>` goes to stdout, which the workflow appends to
 * `$GITHUB_OUTPUT`; the annotations go to stderr, which the runner reads for workflow commands but the
 * workflow does not redirect.
 *
 * Writing both to stdout looked tidier and was wrong: `$GITHUB_OUTPUT` holds `name=value` records split
 * at the first `=`, so every `::warning title=Provider degraded::...` line became an output literally
 * named `::warning title`, the annotation never reached the run page, and the error that followed told a
 * reader to see warnings that did not exist (Codex, #69).
 *
 * Exits 0 whatever it finds. Deciding what a degraded run *means* is the workflow's job; this only
 * reports, and a reporter that can fail the step it reports from is a reporter that hides its subject.
 */
import { escapeAnnotation, readHealth, unexpectedlyDegraded } from "./refresh-health";

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
        // stderr: the runner parses workflow commands from it, and the caller does not redirect it.
        console.error(`::warning title=Provider degraded::${escapeAnnotation(`${provider.game}/${provider.type} is ${provider.status} and nobody has accepted this outage${detail}`)}`);
    }
    console.log(`degraded=${unexpected.length}`);
}
