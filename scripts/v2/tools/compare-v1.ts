/**
 * Runs the V1 provider for a registry entry and compares its result with a
 * slice run's V2 view: which keys differ, and whether the published instant is
 * the same. For the migration report, never for production.
 *
 *   node build/v2/tools/compare-v1.js lol next-patch build/slice/with-config-run1.json
 */
import * as fs from "fs";
import { ProviderResult } from "../../types";

const V1_PROVIDERS: Record<string, () => Promise<{ run: () => Promise<ProviderResult> }>> = {
    "lol/next-patch": () => import("../../providers/lol")
};

const VOLATILE = new Set(["fetched_at_utc", "last_success_at_utc"]);

async function main(): Promise<void> {
    const [gameId, type, sliceFile] = process.argv.slice(2);
    const key = `${gameId}/${type}`;
    const loader = V1_PROVIDERS[key];
    if (!loader || !sliceFile) {
        console.error(`usage: compare-v1 <game> <type> <slice.json>; known: ${Object.keys(V1_PROVIDERS).join(", ")}`);
        process.exit(2);
    }
    const slice = JSON.parse(fs.readFileSync(sliceFile, "utf8")) as { view: ProviderResult };
    const v2 = slice.view;
    let v1: ProviderResult | { status: "crashed"; error: string };
    try {
        v1 = await (await loader()).run();
    } catch (error) {
        v1 = { status: "crashed", error: error instanceof Error ? error.message : String(error) };
    }

    const keysV1 = Object.keys(v1);
    const keysV2 = Object.keys(v2);
    const differences: Array<{ key: string; v1: unknown; v2: unknown }> = [];
    for (const k of new Set([...keysV1, ...keysV2])) {
        if (VOLATILE.has(k)) continue;
        const a = (v1 as unknown as Record<string, unknown>)[k];
        const b = (v2 as unknown as Record<string, unknown>)[k];
        if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ key: k, v1: a, v2: b });
    }
    const out = {
        comparedAt: new Date().toISOString(),
        v1,
        v2,
        sameKeyOrder: JSON.stringify(keysV1) === JSON.stringify(keysV2),
        sameInstant: (v1 as { nextEventUtc?: string | null }).nextEventUtc === (v2 as { nextEventUtc?: string | null }).nextEventUtc,
        differences
    };
    console.log(JSON.stringify(out, null, 2));
}

main().catch(error => {
    console.error("compare failed:", error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
});
