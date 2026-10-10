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
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.resolve(__dirname, "..", "..", "..", "public");
const read = (asset: string) => fs.readFileSync(path.join(PUBLIC, asset));

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

test("no page references an image that is not in the build", () => {
    const pages: string[] = [];
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".html")) pages.push(full);
        }
    };
    walk(PUBLIC);
    let checked = 0;
    for (const page of pages) {
        const html = fs.readFileSync(page, "utf8");
        for (const match of html.matchAll(/(?:href|content|src)="(?:https:\/\/nextreset\.co)?(\/[^"]+\.(?:png|jpg|jpeg|svg|ico|webp))"/g)) {
            const asset = match[1].replace(/^\//, "");
            assert.ok(fs.existsSync(path.join(PUBLIC, asset)), `${path.relative(PUBLIC, page)} references ${match[1]}, which does not exist`);
            checked++;
        }
    }
    assert.ok(checked >= pages.length, "the pages reference fewer images than there are pages; the scan is probably not matching");
});
