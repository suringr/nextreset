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
 *
 * Evidence is the fetched manifest itself: the document is the manifest URL and
 * its content hash, and the claim quotes the release's entry exactly as it
 * appears in that response. Evidence is recorded only when the release instant
 * is new to the knowledge file, so a manifest that changes for snapshots does
 * not add copies. The manifest is machine data, so visitors keep the official
 * changelogs page as the link (TopicView.linkEvidence).
 *
 * No model is involved: an unchanged manifest stops at the text hash, and a
 * changed one is parsed by code.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { Adapter } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
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
    /** The release's entry exactly as it appears in the manifest text. */
    excerpt: string;
}

/** The release's entry as a verbatim slice of the manifest text (entries hold no nested objects). */
function entryExcerpt(text: string, id: string): string | undefined {
    for (const match of text.matchAll(/\{[^{}]*\}/g)) {
        try {
            if ((JSON.parse(match[0]) as { id?: unknown }).id === id) return match[0];
        } catch {
            // Not a standalone object: keep scanning.
        }
    }
    return undefined;
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
    const excerpt = entryExcerpt(text, id);
    if (!excerpt) throw new Error(`The manifest entry for ${id} cannot be quoted verbatim`);
    return { id, at: at.toISOString(), releaseTime: entry.releaseTime, excerpt };
}

function sha(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/** The fetched manifest as the evidence document, and the claim quoting the release entry from it. */
export function javaReleaseEvidence(release: JavaRelease, manifest: FetchedDocument, gameId: string, topicType: string, sourceId: string): { document: Document; claim: Claim } {
    const key = eventKey(gameId, topicType, release.id);
    const documentId = manifest.textHash;
    return {
        document: { id: documentId, url: manifest.finalUrl, sourceId, fetchedAt: manifest.fetchedAt, title: "Mojang version manifest", fetchMode: manifest.mode, confidence: Confidence.High },
        claim: { id: sha(`${documentId}|${key}|at|${release.at}`).slice(0, 24), documentId, eventKey: key, field: "at", value: release.at, method: "deterministic", quote: release.excerpt, extractedAt: manifest.fetchedAt }
    };
}

/** `transport` is injectable for tests; production uses the default HTTP transport (no rendering for JSON). */
export function createMinecraftJavaAdapter(transport?: Transport): Adapter {
    return async ({ game, topic, now, getSourceState, knowledge }) => {
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

        // Evidence only when this release instant is new: a manifest that changed for snapshots adds no copies.
        const key = eventKey(game.id, topic.type, release.id);
        const alreadyEvidenced = knowledge.claims.some(c => c.eventKey === key && c.field === "at" && c.value === release.at);
        const evidence = alreadyEvidenced ? undefined : javaReleaseEvidence(release, fetched.document!, game.id, topic.type, source.id);
        return {
            events: [{ identity: release.id, label: release.id, status: "observed", at: release.at, precision: "exact", timezone: "UTC" }],
            // The manifest is authoritative about which release is current: a rolled-back latest.release retires the newer one.
            currentIdentity: release.id,
            documents: evidence ? [evidence.document] : [],
            claims: evidence ? [evidence.claim] : [],
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
