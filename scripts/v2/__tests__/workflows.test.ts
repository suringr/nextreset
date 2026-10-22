/**
 * What the workflows may spend, read from the workflow files themselves.
 *
 * Two workflows make billed model calls on purpose (the gold evaluation and the vertical slice). Both
 * used to start by themselves when a pull request touching AI files was opened, so routine development
 * paid for evaluations nobody asked for. These checks hold the opposite in place: a live evaluation
 * starts only from a manual dispatch with an explicit confirmation, and the only scheduled or automatic
 * path to the API key is the production refresh, which runs under the daily budget gate.
 *
 * The checks read YAML as text on purpose (no YAML dependency for a test). They look at indentation the
 * way these files are written; a reformatted file that defeats them fails loudly rather than passing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { APPROVED_LIVE_EVAL_MODELS, liveEvalRefusal, modelRefusal } from "../ai/eval-guard";

const WORKFLOWS = path.join(__dirname, "..", "..", "..", ".github", "workflows");
const read = (name: string) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8").replace(/\r\n/g, "\n");
const LIVE_EVALS = ["ai-eval.yml", "slice-eval.yml"];

/** The event names under the top-level `on:` key. */
function triggers(yaml: string): string[] {
    const lines = yaml.split(/\r?\n/);
    const start = lines.findIndex(l => /^on:\s*$/.test(l));
    assert.notEqual(start, -1, "workflow has no block-style `on:` key");
    const events: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line)) break;
        const m = /^  ([a-z_]+):/.exec(line);
        if (m) events.push(m[1]);
    }
    return events;
}

/** The text of one job, from its key to the next job key. */
function jobBlock(yaml: string, job: string): string {
    const lines = yaml.split(/\r?\n/);
    const start = lines.findIndex(l => l === `  ${job}:`);
    assert.notEqual(start, -1, `no job ${job}`);
    const end = lines.findIndex((l, i) => i > start && /^  [a-z][\w-]*:\s*$/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

test("live evaluations start only from a manual dispatch", () => {
    for (const name of LIVE_EVALS) {
        assert.deepEqual(triggers(read(name)), ["workflow_dispatch"], `${name} must have no automatic trigger`);
    }
});

test("live evaluations need an explicit confirmation, default off", () => {
    for (const name of LIVE_EVALS) {
        const yaml = read(name);
        assert.match(yaml, /confirm_paid_run:\n\s+description: .*billed.*\n\s+type: boolean\n\s+required: true\n\s+default: false/, `${name}: confirmation input`);
        assert.match(yaml, /\n    if: \$\{\{ inputs\.confirm_paid_run == true \}\}\n/, `${name}: the job is gated on the confirmation`);
    }
});

test("live evaluations are never cancelled mid-run and keep read-only permissions", () => {
    for (const name of LIVE_EVALS) {
        const yaml = read(name);
        assert.match(yaml, /cancel-in-progress: false/, `${name}: a cancelled run wastes calls already billed`);
        assert.match(yaml, /\npermissions:\n  contents: read\n/, `${name}: permissions`);
        assert.doesNotMatch(yaml, /contents: write|id-token|actions: write/, `${name}: no write permission`);
    }
});

test("live evaluations offer only approved models and topics, and never interpolate inputs into a script", () => {
    const evalYaml = read("ai-eval.yml");
    const options = /model:\n(?:.*\n)*?\s+options:\n((?:\s+- .*\n)+)/.exec(evalYaml);
    assert.ok(options, "ai-eval.yml model input is a choice");
    assert.deepEqual(options![1].trim().split(/\n/).map(l => l.replace(/^\s*- /, "").trim()), [...APPROVED_LIVE_EVAL_MODELS]);
    assert.match(evalYaml, /node build\/v2\/ai\/eval-guard\.js/, "ai-eval.yml re-checks the model before the paid step");

    for (const name of LIVE_EVALS) {
        // A `run:` script containing ${{ inputs.* }} is shell injection from the dispatch form.
        const lines = read(name).split(/\r?\n/);
        let inRun = false;
        let runIndent = 0;
        for (const line of lines) {
            const indent = line.length - line.trimStart().length;
            if (inRun && line.trim() !== "" && indent <= runIndent) inRun = false;
            const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
            if (m) {
                inRun = true;
                runIndent = m[1].length;
                assert.doesNotMatch(m[2], /\$\{\{\s*inputs\./, `${name}: inputs interpolated into a script: ${line.trim()}`);
                continue;
            }
            if (inRun) assert.doesNotMatch(line, /\$\{\{\s*inputs\./, `${name}: inputs interpolated into a script: ${line.trim()}`);
        }
    }
});

test("the API key reaches only the production publish job and the two confirmed evaluations", () => {
    const files = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f));
    const holders = files.filter(f => read(f).includes("secrets.GEMINI_API_KEY")).sort();
    assert.deepEqual(holders, ["ai-eval.yml", "refresh-data.yml", "slice-eval.yml"]);

    // The refresh workflow also runs on pull requests; that job builds and tests only.
    const refresh = read("refresh-data.yml");
    assert.doesNotMatch(jobBlock(refresh, "pr-check"), /secrets\./, "the pull-request job must not see any secret");
    assert.match(jobBlock(refresh, "publish"), /secrets\.GEMINI_API_KEY/);
    assert.match(jobBlock(refresh, "publish"), /if: \$\{\{ github\.event_name != 'pull_request' \}\}/, "the publish job never runs for a pull request");
});

test("a live evaluation refuses to start without its confirmation and an approved, priced model", () => {
    assert.match(liveEvalRefusal({ AI_MODEL: "gemini-3.5-flash" })!, /AI_LIVE_EVAL_CONFIRMED=1/);
    assert.equal(liveEvalRefusal({ AI_LIVE_EVAL_CONFIRMED: "1", AI_MODEL: "gemini-3.5-flash" }), undefined);
    assert.match(liveEvalRefusal({ AI_LIVE_EVAL_CONFIRMED: "true", AI_MODEL: "gemini-3.5-flash" })!, /AI_LIVE_EVAL_CONFIRMED=1/, "only the exact value confirms");
    assert.match(liveEvalRefusal({ AI_LIVE_EVAL_CONFIRMED: "1", AI_MODEL: "gemini-9-ultra" })!, /not approved/);
    // AI_MODEL unset or blank means the provider's default, which is what would actually be called.
    assert.equal(liveEvalRefusal({ AI_LIVE_EVAL_CONFIRMED: "1" }), undefined);
    assert.equal(liveEvalRefusal({ AI_LIVE_EVAL_CONFIRMED: "1", AI_MODEL: "  " }), undefined);
    assert.match(modelRefusal("")!, /no model/);
    assert.match(modelRefusal(undefined)!, /no model/);
    for (const model of APPROVED_LIVE_EVAL_MODELS) assert.equal(modelRefusal(model), undefined, `${model} must be priced`);
});

test("unit tests run without the API key", () => {
    // run-tests.ts strips it before any test process starts; this test runs in one of those processes.
    assert.equal(process.env.GEMINI_API_KEY, undefined);
    assert.equal(process.env.AI_LIVE_EVAL_CONFIRMED, undefined);
});
