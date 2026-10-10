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
 * Each run upserts the current release and the eleven before it, all read from
 * the same response. The manifest lists every version Minecraft has ever had, so
 * the page's history costs no extra request; `KEPT_RELEASES` bounds what is taken
 * from it, because a page is not a data dump.
 *
 * Evidence is the fetched manifest itself: the document is the manifest URL and
 * its content hash, and each claim quotes its release's entry exactly as it
 * appears in that response. Evidence is recorded only when a release instant is
 * new to the knowledge file, so a manifest that changes for snapshots does not
 * add copies. The manifest is machine data, so every row's link is the official
 * changelogs page rather than raw launcher JSON.
 *
 * No model is involved: an unchanged manifest stops at the text hash, and a
 * changed one is parsed by code.
 */
import * as crypto from "crypto";
import { Confidence } from "../../types";
import { failureKindFromFetch } from "../reasons";
import { Adapter } from "../adapter";
import { Claim, Document, SourceState } from "../domain";
import { FetchedDocument, smartFetch } from "../fetch/smart-fetch";
import { Transport } from "../fetch/transport";
import { eventKey } from "../identity";
import { indexJsonObjects } from "../json-quote";

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
    const excerpt = indexJsonObjects(text, "id").get(id);
    if (!excerpt) throw new Error(`The manifest entry for ${id} cannot be quoted verbatim`);
    return { id, at: at.toISOString(), releaseTime: entry.releaseTime, excerpt };
}

/**
 * How many releases the page keeps.
 *
 * The manifest lists every version Minecraft has ever had — hundreds — and importing all of them
 * would be a data dump rather than a page. Twelve is what `render-data-blocks` will draw (its current
 * event plus eleven rows of history), so storing more would cost bytes on every run to show nothing.
 */
export const KEPT_RELEASES = 12;

/**
 * The most recent releases the manifest names, newest first.
 *
 * The same response `parseLatestJavaRelease` reads. It already contains every version with its id,
 * its type and its release instant, so the whole of this page's history is in bytes the build has
 * already paid for: no second request, no new source, no crawl.
 *
 * Releases only, as the page has always promised. Snapshots and release candidates are test builds,
 * `/minecraft/last-release/` is about releases, and mixing them in would quietly change what the page
 * means. The manifest's own `type` field is what decides, so this is the source's distinction and not
 * ours. Ordered by `releaseTime`, never by position: the array's order is Mojang's business.
 */
export function parseRecentJavaReleases(text: string, limit = KEPT_RELEASES): JavaRelease[] {
    let data: any;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON in Mojang version manifest");
    }
    const versions = data?.versions;
    if (!Array.isArray(versions)) throw new Error("No versions in Mojang version manifest");
    const quoted = indexJsonObjects(text, "id");
    const releases: JavaRelease[] = [];
    const seen = new Set<string>();
    for (const entry of versions) {
        if (entry?.type !== "release") continue;
        if (typeof entry.id !== "string" || typeof entry.releaseTime !== "string") continue;
        const at = new Date(entry.releaseTime);
        if (isNaN(at.getTime())) continue;
        // One entry per id. `indexJsonObjects` keys quotes by id and keeps the first, so a manifest
        // listing an id twice would hand the second entry the first entry's quote — a claim whose
        // value says one instant and whose supposedly verbatim evidence says another, both upserted
        // against the same event key. The first entry wins, which is the one the quote belongs to.
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const excerpt = quoted.get(entry.id);
        // A release that cannot be quoted verbatim is not evidence, and history without evidence is
        // just a list. Skipped rather than fatal: one unquotable old version must not cost the page
        // the current release, which parseLatestJavaRelease checks for separately and strictly.
        if (!excerpt) continue;
        // And the quote must be the quote for this entry, not merely a quote that exists. Cheap to
        // check, and it is the only thing standing between "verbatim evidence" and a plausible string.
        let quotedEntry: { releaseTime?: unknown };
        try {
            quotedEntry = JSON.parse(excerpt);
        } catch {
            continue;
        }
        if (quotedEntry.releaseTime !== entry.releaseTime) continue;
        releases.push({ id: entry.id, at: at.toISOString(), releaseTime: entry.releaseTime, excerpt });
    }
    return releases.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
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
        claim: {
            // The link is part of the identity, so a claim written before this adapter set one is not
            // mistaken for this one. Evidence is append-only (pipeline.ts: a claim whose id is already
            // present is dropped), which is the right rule — but it means an upgrade cannot improve a
            // claim in place. It can add a better one, and `evidenceFor` takes the newest, so the row
            // ends up pointing at the changelogs page rather than at raw launcher JSON.
            id: sha(`${documentId}|${key}|at|${release.at}|${MINECRAFT_CHANGELOGS_PAGE}`).slice(0, 24),
            documentId,
            eventKey: key,
            field: "at",
            value: release.at,
            method: "deterministic",
            quote: release.excerpt,
            // What the evidence is and what a reader should be given are not the same URL. The manifest
            // is the document this was read from and the thing that can be quoted; the changelogs page
            // is where Mojang writes up a release for people. A row linking to raw launcher JSON would
            // be citing our working rather than their announcement.
            linkUrl: MINECRAFT_CHANGELOGS_PAGE,
            extractedAt: manifest.fetchedAt
        }
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
            return { events: [], failure: fetched.error ?? fetched.verdict?.reason ?? "fetch failed", failureKind: failureKindFromFetch(fetched), sourceStates };
        }
        const fetch = { httpStatus: fetched.document?.status ?? 304, mode: fetched.document?.mode ?? "http" as const };
        // An unchanged response still gets read when the body came down with it.
        //
        // `unchanged` covers two different things: a 304, which has no body at all, and a 200 whose
        // hash matched, which has one. Returning early for both was right when a run imported only the
        // current release — there was nothing new to learn from bytes we had seen before. It is wrong
        // now: on the first deploy after this change the store holds no history, and the manifest will
        // read as unchanged until Mojang next publishes anything. Where the body is in our hands,
        // parsing it imports the history for no request at all; the upserts are idempotent, so a run
        // that learns nothing new writes nothing.
        //
        // A true 304 has no body and cannot be read. The next change to the manifest — Mojang ships
        // snapshots most weeks — completes the import, and nothing is published wrongly in the interim.
        const unchanged = fetched.outcome === "unchanged";
        const skipped = { events: [], unchanged: true, sourceStates, fetch, work: { unchanged: 1, deterministic: 0, sentToAi: 0, deferred: 0 } };
        // Nothing to re-read once the store already holds as much history as a run would ever take
        // from this response, so the common case after the backfill costs exactly what it did before:
        // no parse at all. Before then, a body in hand is worth reading.
        const held = knowledge.events.filter(event => event.topic === topic.type).length;
        if (unchanged && (!fetched.document || held >= KEPT_RELEASES)) return skipped;

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
            return { events: [], failure: error instanceof Error ? error.message : String(error), failureKind: "extraction-failed", sourceStates };
        }

        // The releases this manifest names, current one first.
        //
        // The page used to publish one date and nothing else, because this adapter stored only
        // `latest.release` and let history accumulate from the first run onwards — which after a month
        // was still one row. The manifest has always carried the whole list; it simply was not read.
        const kept = parseRecentJavaReleases(fetched.document!.body);
        const releases = [release, ...kept.filter(previous => previous.id !== release.id)];

        // Evidence for each, and only where it is new: a manifest that changed for snapshots adds no
        // copies, and an unchanged response never gets this far.
        //
        // Every one of these is genuinely evidenced — the manifest is the document, and each release's
        // entry is a verbatim quote of it — which is exactly what `blocksFor` requires before it will
        // list a past event. Storing the history without claims looked like a saving and was really a
        // way to have the rows and never show them: that rule exists so a rule-generated occurrence
        // cannot claim a provenance it does not have, and these have one.
        const documents: Document[] = [];
        const claims: Claim[] = [];
        for (const candidate of releases) {
            const key = eventKey(game.id, topic.type, candidate.id);
            // Skipped only where the stored evidence already carries the reader's link. A claim from
            // before the rescue states the same instant with no `linkUrl`, and treating that as
            // "already evidenced" would leave the row sending readers to the manifest JSON for good.
            const linked = knowledge.claims.some(c =>
                c.eventKey === key && c.field === "at" && c.value === candidate.at && c.linkUrl === MINECRAFT_CHANGELOGS_PAGE);
            if (linked) continue;
            const evidence = javaReleaseEvidence(candidate, fetched.document!, game.id, topic.type, source.id);
            if (!documents.some(d => d.id === evidence.document.id)) documents.push(evidence.document);
            claims.push(evidence.claim);
        }

        return {
            events: releases.map(candidate => ({
                identity: candidate.id,
                label: candidate.id,
                status: "observed" as const,
                at: candidate.at,
                precision: "exact" as const,
                timezone: "UTC"
            })),
            // The manifest is authoritative about which release is current: a rolled-back latest.release retires the newer one.
            currentIdentity: release.id,
            documents,
            claims,
            confidence: Confidence.High,
            sourceStates,
            fetch,
            // Structured JSON parsed by code: never sent to a model. Re-reading a response we had
            // already seen is deterministic work like any other -- `unchanged` means "skipped without
            // parsing" in the run report, and this path parsed.
            work: { unchanged: 0, deterministic: 1, sentToAi: 0, deferred: 0 }
        };
    };
}
