/**
 * The image assets, and whether they are what they say they are.
 *
 * `favicon.png` and `og.png` were both **JPEG files with .png names**, served as `image/png`. Browsers
 * sniff the bytes so nothing visibly broke, which is exactly why it survived: the site shipped a
 * 360 KB favicon on every page view, and a 1024x1024 square as its Open Graph card, for as long as
 * nobody opened the files.
 *
 * Everything asserted here is a fact about the file rather than a preference about it: the magic bytes
 * match the extension, the pixel dimensions match what the markup and the manifest claim, and nothing
 * references an asset that is not there. No size limits — a budget is a judgement, and this file is for
 * the things that are simply true or false.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { pagePaths } from "../../site-map";

const PUBLIC = path.resolve(__dirname, "..", "..", "..", "public");
const read = (asset: string) => fs.readFileSync(path.join(PUBLIC, asset));

/** Every authored page, as a path relative to public/. */
function pages(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) out.push(path.relative(PUBLIC, full).split(path.sep).join("/"));
        }
    };
    walk(PUBLIC);
    return out.sort();
}

type Picture = { format: "png" | "jpeg" | "ico" | "unknown"; width?: number; height?: number };

/** What a file actually is, read from its own header rather than from its name. */
function identify(bytes: Buffer): Picture {
    if (bytes.slice(0, 8).toString("hex") === "89504e470d0a1a0a") {
        // Walk the chunks to IHDR rather than assuming it is first.
        let at = 8;
        while (at + 8 <= bytes.length) {
            const length = bytes.readUInt32BE(at);
            const type = bytes.slice(at + 4, at + 8).toString("ascii");
            if (type === "IHDR") return { format: "png", width: bytes.readUInt32BE(at + 8), height: bytes.readUInt32BE(at + 12) };
            at += 12 + length;
        }
        return { format: "png" };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2;
        while (at + 9 < bytes.length) {
            if (bytes[at] !== 0xff) { at++; continue; }
            const marker = bytes[at + 1];
            // Any start-of-frame carries the dimensions; the arithmetic ones and DHT/DAC/RST do not.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { format: "jpeg", height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
            }
            at += 2 + bytes.readUInt16BE(at + 2);
        }
        return { format: "jpeg" };
    }
    if (bytes.readUInt32LE(0) === 0x00010000) return { format: "ico" };
    return { format: "unknown" };
}

/**
 * The sizes an .ico actually contains, read from its directory.
 *
 * Accepting the file on its four-byte signature alone (Codex, #70) would pass an icon with an empty or
 * truncated directory — exactly the file that looks fine in git and renders nothing in a browser tab.
 * A dimension byte of 0 means 256 in the ICO format, which is the one piece of arithmetic here.
 */
function icoEntries(bytes: Buffer): { entries: Array<{ width: number; height: number; bytes: number }>; declared: number } {
    const declared = bytes.readUInt16LE(4);
    const entries: Array<{ width: number; height: number; bytes: number }> = [];
    for (let i = 0; i < declared; i++) {
        const at = 6 + i * 16;
        // Every declared entry is returned or the count is wrong, which is itself the defect. Skipping
        // the ones that do not parse (Codex, #70) let a file declaring five entries pass with four: the
        // fifth read a PNG payload as a directory record, fell outside the file, and was dropped in
        // silence. A directory that does not describe the file is a corrupt directory.
        if (at + 16 > bytes.length) break;
        const size = bytes.readUInt32LE(at + 8);
        const offset = bytes.readUInt32LE(at + 12);
        if (offset + size > bytes.length || size === 0) break;
        entries.push({ width: bytes[at] === 0 ? 256 : bytes[at], height: bytes[at + 1] === 0 ? 256 : bytes[at + 1], bytes: size });
    }
    return { entries, declared };
}

const EXPECTED: Array<{ asset: string; format: Picture["format"]; width?: number; height?: number }> = [
    { asset: "favicon.ico", format: "ico" },
    { asset: "favicon.png", format: "png", width: 32, height: 32 },
    { asset: "apple-touch-icon.png", format: "png", width: 180, height: 180 },
    { asset: "icon-192.png", format: "png", width: 192, height: 192 },
    { asset: "icon-512.png", format: "png", width: 512, height: 512 },
    // 1200x630 is the ratio Open Graph consumers crop to; a square was being letterboxed or cropped by
    // each of them differently.
    { asset: "og.jpg", format: "jpeg", width: 1200, height: 630 }
];

test("every image asset is the format its name claims, at the size the markup claims", () => {
    for (const expected of EXPECTED) {
        const file = path.join(PUBLIC, expected.asset);
        assert.ok(fs.existsSync(file), `${expected.asset} is referenced but not in public/`);
        const actual = identify(read(expected.asset));
        assert.equal(actual.format, expected.format, `${expected.asset} is a ${actual.format} with a .${expected.asset.split(".").pop()} name`);
        if (expected.width !== undefined) {
            assert.deepEqual([actual.width, actual.height], [expected.width, expected.height],
                `${expected.asset} is ${actual.width}x${actual.height}, not ${expected.width}x${expected.height}`);
        }
    }
});

test("favicon.ico really contains the sizes a browser will probe for", () => {
    const { entries, declared } = icoEntries(read("favicon.ico"));
    assert.ok(declared > 0, "favicon.ico declares no icons");
    assert.equal(entries.length, declared,
        `favicon.ico declares ${declared} icon(s) and only ${entries.length} of them point at real data`);
    const sizes = entries.map(entry => `${entry.width}x${entry.height}`).sort();
    assert.deepEqual(sizes, ["16x16", "24x24", "32x32", "48x48"].sort(), `favicon.ico contains ${sizes.join(", ")}`);
});

test("the manifest's icons exist at the sizes it declares", () => {
    // It used to declare 192 and 512 while pointing both at a single 1024x1024 JPEG.
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC, "site.webmanifest"), "utf8")) as {
        icons: Array<{ src: string; sizes: string; type: string }>;
    };
    assert.ok(manifest.icons.length > 0, "the manifest declares no icons");
    for (const icon of manifest.icons) {
        const asset = icon.src.replace(/^\//, "");
        assert.ok(fs.existsSync(path.join(PUBLIC, asset)), `the manifest declares ${icon.src}, which does not exist`);
        const actual = identify(read(asset));
        assert.equal(`${actual.width}x${actual.height}`, icon.sizes, `${icon.src} is ${actual.width}x${actual.height}, declared as ${icon.sizes}`);
        assert.equal(`image/${actual.format}`, icon.type, `${icon.src} is ${actual.format}, declared as ${icon.type}`);
    }
});

test("every image a page references is in the build, checked page by page", () => {
    // The first version of this counted matches across the whole repository and asserted the total was
    // at least the number of pages (Codex, #70). Matches from other pages kept that true, so a page
    // whose reference the regex stopped recognising — single quotes, a query string — would simply
    // contribute nothing and pass. After deleting og.png, that is a broken social card that ships.
    //
    // Each page is now checked for the references it is supposed to have, through a parser rather than
    // a pattern.
    const all = pages();
    assert.deepEqual(all.filter(page => page !== "404.html").sort(), pagePaths().filter(page => page !== "404.html").sort(),
        "the pages on disk are not the pages the manifest declares");

    for (const page of all) {
        const $ = cheerio.load(read(page));
        const referenced = new Set<string>();
        const note = (value: string | undefined) => {
            if (!value) return;
            const url = value.replace(/^https:\/\/nextreset\.co/, "").split("?")[0];
            if (/^\/[^/].*\.(png|jpe?g|svg|ico|webp)$/i.test(url)) referenced.add(url.slice(1));
        };
        $("link[rel*='icon']").each((_, el) => note($(el).attr("href")));
        $("meta[property='og:image'], meta[name='twitter:image']").each((_, el) => note($(el).attr("content")));
        $("img").each((_, el) => note($(el).attr("src")));

        for (const asset of referenced) {
            assert.ok(fs.existsSync(path.join(PUBLIC, asset)), `${page} references /${asset}, which does not exist`);
        }
        // Every page carries the icon set and the social card. A page that suddenly references none of
        // them has lost its head tags, which no existence check would notice.
        assert.ok(referenced.has("favicon.ico"), `${page} declares no .ico favicon`);
        assert.ok(referenced.has("apple-touch-icon.png"), `${page} declares no apple-touch-icon`);
        if (page !== "404.html") {
            assert.ok(referenced.has("og.jpg"), `${page} declares no Open Graph image`);
        }
    }
});
