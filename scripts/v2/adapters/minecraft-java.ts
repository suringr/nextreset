/**
 * Minecraft: Java Edition last release (structured JSON source, deterministic parse).
 *
 * Source: Mojang's launcher version manifest, the file the official launcher
 * reads to offer versions. `latest.release` names the current release, and its
 * entry carries `releaseTime`, exact to the second. `time` is not used: it
 * changes whenever Mojang re-uploads the version files.
 *
 * Only releases are tracked. Snapshots, pre-releases and release candidates are
 * test versions, and the existing page (minecraft/last-release) describes the
 * latest Java Edition release. Bedrock Edition has its own source and is not
 * mixed in here (V1 mixed both editions from one changelog listing).
 *
 * Each run upserts only the latest release, so the knowledge file does not
 * import hundreds of old versions; history accumulates from the first run on.
 * Evidence is the manifest entry, recorded as a document with one deterministic
 * claim quoting the fields the instant came from. That entry is machine data,
 * so visitors keep the official changelogs page as the link (TopicView.linkEvidence).
 *
 * No model is involved: an unchanged manifest stops at the text hash, and a
 * changed one is parsed by code.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";

export const MINECRAFT_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
export const MINECRAFT_CHANGELOGS_PAGE = "https://feedback.minecraft.net/hc/en-us/sections/360001186971-Release-Changelogs";

export interface JavaRelease {
    /** Version id, e.g. "26.3". */
    id: string;
    /** Release instant, ISO 8601 UTC. */
    at: string;
    /** `releaseTime` exactly as the manifest gives it. */
    releaseTime: string;
    /** The version's own metadata URL on piston-meta. */
    url: string;
}

/** The latest Java Edition release named by the manifest. Throws when the manifest cannot vouch for one. */
export function parseLatestJavaRelease(text: string): JavaRelease {
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in Mojang version manifest");
    }
    const id = data?.latest?.release;
    if (typeof id !== "string" || id.trim() === "") throw new Error("No latest.release in Mojang version manifest");
    const versions = data?.versions;
    if (!Array.isArray(versions)) throw new Error("No versions in Mojang version manifest");
    const entry = versions.find((v: any) => v?.id === id);
    if (!entry) throw new Error(`latest.release ${JSON.stringify(id)} has no entry in the manifest`);
    if (entry.type !== "release") throw new Error(`latest.release ${JSON.stringify(id)} is listed as ${JSON.stringify(entry.type)}, not a release`);
    const at = typeof entry.releaseTime === "string" ? new Date(entry.releaseTime) : new Date(NaN);
    if (isNaN(at.getTime())) throw new Error(`Invalid releaseTime for ${id}: ${JSON.stringify(entry.releaseTime)}`);
    return {
        id,
        at: at.toISOString(),
        releaseTime: entry.releaseTime,
        url: typeof entry.url === "string" && /^https:\/\//i.test(entry.url) ? entry.url : MINECRAFT_MANIFEST_URL
    };
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/** The document and claim behind a release's event. Ids are content-derived, so re-reading adds nothing. */
export function javaReleaseEvidence(release: JavaRelease, gameId: string, topicType: string, sourceId: string, fetchedAt: string): { document: Document; claim: Claim } {
    const quote = JSON.stringify({ id: release.id, type: "release", releaseTime: release.releaseTime });
    const documentId = sha(`mojang-version-manifest|${quote}`);
    const key = eventKey(gameId, topicType, release.id);
    return {
        document: { id: documentId, url: release.url, sourceId, fetchedAt, title: `Minecraft: Java Edition ${release.id}`, fetchMode: "http", confidence: Confidence.High },
        claim: { id: sha(`${documentId}|${key}|at|${release.at}`).slice(0, 24), documentId, eventKey: key, field: "at", value: release.at, method: "deterministic", quote, extractedAt: fetchedAt }
    };
}

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering for JSON). */
export function createMinecraftJavaAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState }) => {
        const source = game.sources.find(s => s.id === topic.sourceId);
        if (!source) throw new Error(`Source ${topic.sourceId} is not configured for ${game.id}`);

        // Validators and hashes belong to a URL: if the configured source moved, start from nothing.
        const stored = getSourceState(source.id);
        const previous = stored && stored.url === source.url ? stored : undefined;

        const fetched = await smartFetch(source.url, { expect: { kind: "json" }, allowRender: false, previous, transport, label: `${game.id}-${topic.type}`, now });
        const sourceStates: SourceState[] = [{ id: source.id, url: source.url, ...fetched.state }];
        if (fetched.outcome === "unusable") {
            return { events: [], failure: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", sourceStates };
        }
        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
        if (fetched.outcome === "unchanged") {
            return { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        }

        let release: JavaRelease;
        try {
            release = parseLatestJavaRelease(fetched.document!.body);
        } catch (error) {
            // A manifest that cannot vouch for a release is a source failure. Keep the last good hash and drop
            // validators, so the same content is examined again next run instead of reading as "unchanged".
            sourceStates[0] = {
                ...sourceStates[0],
                etag: undefined,
                lastModified: undefined,
                textHash: previous?.textHash,
                lastUsableAt: previous?.lastUsableAt,
                lastVerdict: "parse-error",
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1
            };
            return { events: [], failure: error instanceof Error ? error.message : String(error), sourceStates };
        }

        const evidence = javaReleaseEvidence(release, game.id, topic.type, source.id, fetched.document!.fetchedAt);
        return {
            events: [{ identity: release.id, label: release.id, status: "observed", at: release.at, precision: "exact", timezone: "UTC" }],
            documents: [evidence.document],
            claims: [evidence.claim],
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
