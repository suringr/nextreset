/**
 * Link extraction from fetched HTML: the raw material for seed-page discovery
 * and for the "secondary page links to an official page" hop.
 */
import * as cheerio from "cheerio";
import { canonicalUrl, isOfficialUrl } from "./urls";

export interface PageLink {
    url: string;
    /** Anchor text (or title/aria-label when the anchor has no text), whitespace-normalized. */
    text: string;
}

/** Absolute, canonical http(s) links of a page, de-duplicated (first text wins). */
export function extractLinks(html: string, baseUrl: string): PageLink[] {
    const $ = cheerio.load(html);
    const seen = new Map<string, PageLink>();
    $("a[href]").each((_, el) => {
        const node = $(el);
        const href = node.attr("href");
        if (!href || /^(javascript|mailto|tel):/i.test(href.trim())) return;
        const url = canonicalUrl(href, baseUrl);
        if (!url) return;
        const text = (node.text() || node.attr("title") || node.attr("aria-label") || "").replace(/\s+/g, " ").trim();
        const existing = seen.get(url);
        if (!existing) seen.set(url, { url, text });
        else if (existing.text.length === 0 && text.length > 0) existing.text = text;
    });
    return [...seen.values()];
}

/** The subset of links that land on one of the official domains. */
export function officialLinks(links: PageLink[], officialDomains: string[]): PageLink[] {
    return links.filter(link => isOfficialUrl(link.url, officialDomains));
}
