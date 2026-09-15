/**
 * MockAiProvider: scripted responses for tests and offline evaluation runs.
 * Records every request so tests can assert on prompts and labels.
 */
import { AiError, AiJsonRequest, AiJsonResponse, AiProvider, AiUsage } from "./provider";

export type MockResponder = (request: AiJsonRequest) => unknown | Promise<unknown>;

export class MockAiProvider implements AiProvider {
    readonly name = "mock";
    readonly requests: AiJsonRequest[] = [];

    constructor(
        readonly model: string,
        private readonly responder: MockResponder,
        private readonly usagePerCall: AiUsage = { inputTokens: 1000, outputTokens: 200 }
    ) { }

    async generateJson(request: AiJsonRequest): Promise<AiJsonResponse> {
        this.requests.push(request);
        const data = await this.responder(request);
        if (data instanceof Error) throw data;
        return { data, usage: { ...this.usagePerCall }, model: this.model };
    }
}

/** Responds by request label; unknown labels throw so a missing script is loud. */
export function scriptedResponder(byLabel: Record<string, unknown>): MockResponder {
    return (request) => {
        if (!(request.label in byLabel)) throw new AiError(`no scripted response for label ${JSON.stringify(request.label)}`, false);
        const value = byLabel[request.label];
        // Fresh copy per call so callers cannot mutate the script.
        return typeof value === "object" && value !== null ? JSON.parse(JSON.stringify(value)) : value;
    };
}
