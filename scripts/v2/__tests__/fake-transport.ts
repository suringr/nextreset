import * as fs from "fs";
import * as path from "path";
import { HttpRequest, HttpResponse, RenderRequest, RenderResponse, Transport } from "../fetch/transport";

/** Fixtures live in the source tree; compiled tests run from build/v2/__tests__. */
export const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "..", "scripts", "v2", "__tests__", "fixtures");

export function fixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

export interface FakeHttp {
    status?: number;
    body?: string;
    finalUrl?: string;
    headers?: Record<string, string>;
    notModified?: boolean;
    /** Throw instead of responding. */
    error?: string;
}

export interface FakeRender {
    status?: number;
    html: string;
    finalUrl?: string;
    error?: string;
}

export interface FakeTransport extends Transport {
    gets: HttpRequest[];
    renders: RenderRequest[];
}

/**
 * A transport that replays scripted responses. `http` entries are consumed in
 * order (the last one repeats); `render` likewise. Omit `render` to model a
 * transport without a browser.
 */
export function fakeTransport(script: { http: FakeHttp[]; render?: FakeRender[]; renderBudget?: number }): FakeTransport {
    let httpIndex = 0;
    let renderIndex = 0;
    const transport: FakeTransport = {
        gets: [],
        renders: [],
        async get(req: HttpRequest): Promise<HttpResponse> {
            transport.gets.push(req);
            const entry = script.http[Math.min(httpIndex++, script.http.length - 1)];
            if (entry.error) throw new Error(entry.error);
            return {
                status: entry.status ?? 200,
                finalUrl: entry.finalUrl ?? req.url,
                headers: entry.headers ?? {},
                body: entry.notModified ? "" : (entry.body ?? ""),
                notModified: entry.notModified ?? false,
                elapsedMs: 1
            };
        }
    };
    if (script.render) {
        const renders = script.render;
        transport.render = async (req: RenderRequest): Promise<RenderResponse> => {
            transport.renders.push(req);
            const entry = renders[Math.min(renderIndex++, renders.length - 1)];
            if (entry.error) throw new Error(entry.error);
            const status = entry.status ?? 200;
            const finalUrl = entry.finalUrl ?? req.url;
            const verdict = req.validate(entry.html, status, finalUrl);
            return { status, finalUrl, html: entry.html, verdict, elapsedMs: 1 };
        };
        transport.renderBudget = () => script.renderBudget ?? 10;
    }
    return transport;
}
