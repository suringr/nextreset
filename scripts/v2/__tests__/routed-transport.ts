import { HttpRequest, HttpResponse, RenderRequest, RenderResponse, Transport } from "../fetch/transport";
import { FakeHttp, FakeRender } from "./fake-transport";

export interface RoutedTransport extends Transport {
    gets: HttpRequest[];
    renders: RenderRequest[];
}

/**
 * A transport that answers by URL: exact match first, then the longest prefix.
 * Unrouted URLs get a 404. `render` entries are keyed the same way.
 */
export function routedTransport(routes: Record<string, FakeHttp>, renders: Record<string, FakeRender> = {}): RoutedTransport {
    const pick = <T>(table: Record<string, T>, url: string): T | undefined => {
        if (table[url] !== undefined) return table[url];
        const prefixes = Object.keys(table).filter(k => url.startsWith(k)).sort((a, b) => b.length - a.length);
        return prefixes.length > 0 ? table[prefixes[0]] : undefined;
    };
    const transport: RoutedTransport = {
        gets: [],
        renders: [],
        async get(req: HttpRequest): Promise<HttpResponse> {
            transport.gets.push(req);
            const entry = pick(routes, req.url);
            if (!entry) return { status: 404, finalUrl: req.url, headers: {}, body: "<html><body>not found</body></html>", notModified: false, elapsedMs: 1 };
            if (entry.error) throw new Error(entry.error);
            return {
                status: entry.status ?? 200,
                finalUrl: entry.finalUrl ?? req.url,
                headers: entry.headers ?? { "content-type": "text/html" },
                body: entry.notModified ? "" : (entry.body ?? ""),
                notModified: entry.notModified ?? false,
                elapsedMs: 1
            };
        },
        async render(req: RenderRequest): Promise<RenderResponse> {
            transport.renders.push(req);
            const entry = pick(renders, req.url);
            if (!entry) throw new Error(`no render route for ${req.url}`);
            if (entry.error) throw new Error(entry.error);
            const status = entry.status ?? 200;
            const finalUrl = entry.finalUrl ?? req.url;
            return { status, finalUrl, html: entry.html, verdict: req.validate(entry.html, status, finalUrl), elapsedMs: 1 };
        },
        renderBudget: () => 10
    };
    return transport;
}
