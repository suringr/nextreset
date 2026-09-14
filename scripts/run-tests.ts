/**
 * Test entry point (`npm test`): runs the compiled test files explicitly.
 *
 * Node's `--test` discovery rules differ by version (Node 20 accepts a directory
 * argument, Node 22+ expands globs, Node 24 also discovers `*.test.ts` sources,
 * which then fail to load). Listing the compiled files under build/ removes that
 * dependency, so `npm run build && npm test` behaves the same everywhere.
 */
import * as fs from "fs";
import * as path from "path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const testsDir = path.join(__dirname, "v2", "__tests__");
const files = fs.existsSync(testsDir)
    ? fs.readdirSync(testsDir).filter(f => f.endsWith(".test.js")).sort().map(f => path.join(testsDir, f))
    : [];

if (files.length === 0) {
    console.error(`No compiled tests found in ${testsDir}. Run "npm run build" first.`);
    process.exit(1);
}

const stream = run({ files, concurrency: true });
stream.on("test:fail", () => { process.exitCode = 1; });
stream.compose(new spec()).pipe(process.stdout);
