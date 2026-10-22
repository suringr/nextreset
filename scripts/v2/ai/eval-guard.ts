/**
 * The checks a live (billed) evaluation must pass before it may call a model.
 *
 * Live evaluations are opt-in twice over: the workflow runs only on a manual dispatch with
 * "confirm_paid_run" ticked, and `eval.js --live` refuses to start unless that confirmation reached it
 * as `AI_LIVE_EVAL_CONFIRMED=1`. The model must be one approved here and priced in the cost table, so
 * a typo or an unpriced model cannot run up calls the estimates know nothing about.
 *
 * These are refusals inside this repository. They do not limit what the Google account can be billed:
 * a provider-side cap is set in Google Cloud billing, by the owner.
 */
import { knownModelPrice } from "../cost/pricing";
import { DEFAULT_AI_MODEL } from "./provider";

/** Models a live evaluation may use. Adding one is a deliberate edit, reviewed like any other. */
export const APPROVED_LIVE_EVAL_MODELS: readonly string[] = ["gemini-3.5-flash"];

/** Why a live evaluation may not run with this environment, or undefined when it may. */
export function liveEvalRefusal(env: NodeJS.ProcessEnv): string | undefined {
    if (env.AI_LIVE_EVAL_CONFIRMED !== "1") {
        return "a live evaluation makes billed model calls; set AI_LIVE_EVAL_CONFIRMED=1 to confirm (the workflow does this only after a manual dispatch with confirm_paid_run ticked)";
    }
    // The same default the provider applies (readAiConfig), so `npm run ai:eval:live` with AI_MODEL unset
    // checks the model it is actually about to call.
    return modelRefusal(env.AI_MODEL?.trim() || DEFAULT_AI_MODEL);
}

/** Why this model may not be used for a live evaluation, or undefined when it may. */
export function modelRefusal(model: string | undefined): string | undefined {
    const id = (model ?? "").trim();
    if (!id) return "no model given (AI_MODEL is empty)";
    if (!APPROVED_LIVE_EVAL_MODELS.includes(id)) {
        return `model ${JSON.stringify(id)} is not approved for live evaluation (approved: ${APPROVED_LIVE_EVAL_MODELS.join(", ")})`;
    }
    if (!knownModelPrice(id)) return `model ${JSON.stringify(id)} has no entry in the cost table (scripts/v2/cost/pricing.ts)`;
    return undefined;
}

if (require.main === module) {
    const refusal = modelRefusal(process.env.AI_MODEL);
    if (refusal) {
        console.error(`::error::${refusal}`);
        process.exit(1);
    }
    console.log(`Model ${process.env.AI_MODEL} is approved and priced.`);
}
