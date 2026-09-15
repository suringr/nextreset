/**
 * Optional AI relevance classification of discovery candidates.
 *
 * Used only where the deterministic ranking cannot separate candidates (see
 * needsAiRelevance). The model sees URLs, titles and snippets, never pages, and
 * its verdict only nudges the score: it can never promote a secondary page to
 * official, and a failed call leaves the deterministic order untouched.
 */
import { AiProvider, AiUsage } from "../ai/provider";
import { Candidate } from "./candidates";

export const RELEVANCE_SCHEMA: Record<string, unknown> = {
    type: "object",
    properties: {
        candidates: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    url: { type: "string" },
                    relevant: { type: "boolean" },
                    reason: { type: "string" }
                },
                required: ["url", "relevant", "reason"]
            }
        }
    },
    required: ["candidates"]
};

const RELEVANCE_SYSTEM = `You judge whether web pages are likely to contain the information a tracker needs, from their URL, title and snippet only.
Rules:
- Judge each candidate on its own. A page is relevant only if it would state the requested facts itself (not a page that merely mentions the game).
- Prefer official schedule, patch-notes, release, maintenance or news pages over community discussion, videos and aggregators.
- Never invent URLs; answer only for the candidates given, each exactly once.
Output JSON matching the schema and nothing else.`;

export interface RelevanceTopic {
    gameName: string;
    /** What the tracker needs, e.g. "the release date of the next League of Legends patch". */
    description: string;
}

export interface RelevanceVerdict {
    url: string;
    relevant: boolean;
    reason: string;
}

export function parseRelevance(data: unknown, allowedUrls: string[]): RelevanceVerdict[] {
    const allowed = new Set(allowedUrls);
    const list = (data as { candidates?: unknown })?.candidates;
    if (!Array.isArray(list)) throw new Error("relevance response has no candidates array");
    const out: RelevanceVerdict[] = [];
    const seen = new Set<string>();
    for (const item of list) {
        if (typeof item !== "object" || item === null) continue;
        const { url, relevant, reason } = item as { url?: unknown; relevant?: unknown; reason?: unknown };
        if (typeof url !== "string" || typeof relevant !== "boolean" || !allowed.has(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, relevant, reason: typeof reason === "string" ? reason.slice(0, 200) : "" });
    }
    return out;
}

export async function classifyRelevance(provider: AiProvider, topic: RelevanceTopic, candidates: Candidate[]): Promise<{ verdicts: RelevanceVerdict[]; usage: AiUsage }> {
    const list = candidates.map((c, i) => `${i + 1}. ${c.url}\n   title: ${c.title ?? ""}\n   snippet: ${c.snippet ?? ""}`).join("\n");
    const prompt = `Game: ${topic.gameName}\nNeeded: ${topic.description}\n\nCandidates:\n${list}`;
    const response = await provider.generateJson({ label: "relevance", system: RELEVANCE_SYSTEM, prompt, schema: RELEVANCE_SCHEMA, maxOutputTokens: 2048 });
    return { verdicts: parseRelevance(response.data, candidates.map(c => c.url)), usage: response.usage };
}

/** AI is worth a call only when the top official candidates are too close to call deterministically. */
export function needsAiRelevance(ranked: Candidate[]): boolean {
    const official = ranked.filter(c => c.tier === "official");
    if (official.length < 2) return false;
    return official[0].score - official[1].score <= 1;
}

/** Applies verdicts as score nudges with explanations. Tier and publishability are untouched. */
export function applyRelevance(candidates: Candidate[], verdicts: RelevanceVerdict[]): Candidate[] {
    const byUrl = new Map(verdicts.map(v => [v.url, v]));
    return candidates.map(c => {
        const v = byUrl.get(c.url);
        if (!v) return c;
        const delta = v.relevant ? 2 : -2;
        return { ...c, score: c.score + delta, reasons: [...c.reasons, `ai: ${v.relevant ? "relevant" : "not relevant"} ${delta > 0 ? "+" : ""}${delta}${v.reason ? ` (${v.reason})` : ""}`] };
    });
}
