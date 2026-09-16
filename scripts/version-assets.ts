/**
 * Give every asset URL a version that changes when the file does.
 *
 * `public/_headers` serves /assets/*.js and /assets/styles*.css with `max-age=31536000, immutable`,
 * and the pages referenced them at a fixed path. A returning visitor therefore kept the script they
 * first downloaded for up to a year: the HTML arrived with today's verified values (it is `no-cache`),
 * and a year-old app.js then rendered them the old way — replacing a rendered value with "Data
 * unavailable" whenever a refresh failed, counting down to a midnight nobody announced, putting a
 * provider's run-together note back. Every client-side correction this project has made was waiting on
 * a cache expiry that had not happened yet.
 *
 * So the build appends the file's own content hash: /assets/app.js?v=6f1c2a9b. The HTML is revalidated
 * on every visit, so a changed asset is picked up immediately, and an unchanged one is still served
 * from cache for a year. Nothing is renamed, so a page cached anywhere still resolves to a real file.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/** Matches an asset reference in authored HTML: src="/assets/app.js", href="/assets/styles.v2.css". */
const ASSET_REFERENCE = /(src|href)="(\/assets\/[^"?#]+)"/g;

/** Eight hex characters of the file's SHA-256: enough to change whenever a byte does. */
export function assetVersion(contents: Buffer | string): string {
    return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 8);
}

export interface VersionedAssets {
    /** Asset path to the version stamped on it, for the build log. */
    versions: Record<string, string>;
    /** How many pages were rewritten. */
    pages: number;
    /** References to files that are not in the build: left exactly as they were. */
    missing: string[];
}

/**
 * Stamps every asset reference in `html` with its file's version.
 *
 * A reference to a file the build does not have is left alone and reported: a missing asset is a
 * separate problem, and rewriting its URL would not fix it.
 */
export function versionAssetsInHtml(html: string, versionOf: (asset: string) => string | undefined): { html: string; missing: string[] } {
    const missing: string[] = [];
    const out = html.replace(ASSET_REFERENCE, (whole, attribute: string, asset: string) => {
        const version = versionOf(asset);
        if (!version) {
            missing.push(asset);
            return whole;
        }
        return `${attribute}="${asset}?v=${version}"`;
    });
    return { html: out, missing };
}

/** Stamps every HTML file in `distDir`. Reads each asset once, however many pages reference it. */
export function versionAssets(distDir: string, htmlFiles: string[]): VersionedAssets {
    const versions: Record<string, string> = {};
    const missing = new Set<string>();
    let pages = 0;

    const versionOf = (asset: string): string | undefined => {
        if (asset in versions) return versions[asset];
        const file = path.join(distDir, asset.replace(/^\//, ""));
        if (!fs.existsSync(file)) return undefined;
        versions[asset] = assetVersion(fs.readFileSync(file));
        return versions[asset];
    };

    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, "utf8");
        const result = versionAssetsInHtml(html, versionOf);
        for (const absent of result.missing) missing.add(absent);
        if (result.html !== html) {
            fs.writeFileSync(file, result.html, "utf8");
            pages++;
        }
    }

    return { versions, pages, missing: [...missing] };
}
