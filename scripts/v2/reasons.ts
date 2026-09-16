/**
 * Why a value could not be refreshed, in words a visitor can act on.
 *
 * Published JSON carries two things: `reason`, one concise sentence, and
 * `reason_code`, the machine-readable kind. Neither ever carries a URL, an
 * environment variable name, a provider message or a stack trace; the internal
 * detail stays in the run logs, the run report and the knowledge file.
 *
 * The kinds are deliberately few, and each says something different to a reader:
 *
 *   source-unreachable     the official site did not answer (network, TLS, 5xx)
 *   source-blocked         it answered, but refused an automated check
 *   awaiting-verification  an official page changed and has not been verified yet
 *   extraction-failed      the page was read but its content could not be used
 *   budget-deferred        verification was postponed to stay inside the AI budget
 *   no-new-information     the source was fine and simply says nothing new
 */
import { FailureReasonCode } from "../types";

export type FailureKind = FailureReasonCode;

export const PUBLIC_REASONS: Record<FailureKind, string> = {
    "source-unreachable": "The official source could not be reached",
    "source-blocked": "The official source refused an automated check",
    "awaiting-verification": "An updated official page is waiting to be verified",
    "extraction-failed": "The official page could not be read",
    "budget-deferred": "An updated official page is waiting to be verified",
    "no-new-information": "No new information has been published"
};

/** The sentence shown next to a stored value. An unrecognised failure stays vague rather than leaking a message. */
export function publicReason(kind: FailureKind | undefined): string {
    return kind ? PUBLIC_REASONS[kind] : "The official source could not be checked";
}

/** Answered, but refused: the request reached the server and was turned away. */
const BLOCKED_STATUS = new Set([401, 403, 407, 429]);

/** The parts of a failed fetch this mapping needs (see fetch/smart-fetch.ts and its verdict codes). */
export interface FetchFailureLike {
    verdict?: { code: string };
    error?: string;
    attempts?: ReadonlyArray<{ status: number }>;
}

/**
 * Maps a failed fetch to a public kind, deterministically: a challenge page or a refusing status is
 * "blocked"; no answer, a transport error or a server error is "unreachable"; anything else reached
 * the page but could not be read.
 */
export function failureKindFromFetch(fetched: FetchFailureLike): FailureKind {
    const status = fetched.attempts?.[fetched.attempts.length - 1]?.status;
    const code = fetched.verdict?.code;
    if (code === "challenge") return "source-blocked";
    if (status !== undefined && BLOCKED_STATUS.has(status)) return "source-blocked";
    // Only a missing answer is "unreachable": no response at all, a transport error, or a server error.
    // A 404 or 410 was answered by the server, so the page was reached and simply cannot be used.
    if (status === undefined || status === 0 || status >= 500) return "source-unreachable";
    return "extraction-failed";
}
