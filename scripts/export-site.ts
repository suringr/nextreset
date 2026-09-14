import fs from "node:fs";
import path from "node:path";

/**
 * Export site: Copy public/ → dist/
 * Used by Cloudflare Pages build process
 */

function rmrf(p: string) {
    if (!fs.existsSync(p)) return;
    fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(s, d);
        else fs.copyFileSync(s, d);
    }
}

const root = process.cwd();
const src = path.join(root, "public");
const out = path.join(root, "dist");

if (!fs.existsSync(src)) {
    console.error("❌ Missing public/ directory. Cannot export site.");
    process.exit(1);
}

console.log("🗑️  Cleaning old dist/...");
rmrf(out);

console.log("📦 Copying public/ → dist/...");
copyDir(src, out);

// Playwright debug captures must never reach the published site, even if a stale
// local copy still exists under public/data/_debug (they are written to build/debug now).
rmrf(path.join(out, "data", "_debug"));

console.log("✅ Exported site: public/ → dist/");
