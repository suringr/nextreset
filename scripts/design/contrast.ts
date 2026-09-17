/**
 * WCAG contrast, so a palette decision can be checked instead of eyeballed.
 *
 * The site shipped `--text-muted: #6b7280` on `#0b0f14` — 3.99:1 — and used it for the info labels, the
 * card meta line, the countdown label and the hero subtitle, all of them 11 to 13 pixels. Every one of
 * those failed AA, and nothing in the build would ever have said so. This module exists so the token
 * file can be held to a number by a test.
 *
 * Only what the site actually needs: opaque sRGB hex against opaque sRGB hex. A translucent fill is
 * checked against the surface it is expected to sit on, which is why the token file names that surface
 * rather than leaving the pairing implicit.
 */

/** 4.5:1 for body text, per WCAG 2.1 SC 1.4.3. */
export const AA_NORMAL = 4.5;

/** 3:1 for text at 24px, or 19px bold — and for the boundary of a control, per SC 1.4.11. */
export const AA_LARGE = 3;

/** #rgb or #rrggbb to channel bytes. Throws on anything else: a typo in a palette is not a colour. */
export function parseHex(hex: string): [number, number, number] {
    const value = hex.trim().replace(/^#/, "");
    const full = value.length === 3 ? value.split("").map(c => c + c).join("") : value;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** Relative luminance, per WCAG 2.1 definition. */
export function luminance(hex: string): number {
    const [r, g, b] = parseHex(hex).map(channel => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two opaque colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

/** Rounded to two places, for a readable assertion message. */
export function ratio(a: string, b: string): number {
    return Math.round(contrast(a, b) * 100) / 100;
}

/**
 * Hue in degrees, for asking whether two colours read as different colours.
 *
 * Contrast is the wrong question for that: it compares luminance, so a vivid green and a vivid amber
 * score about 1:1 against each other while being obviously different to look at. The site's three data
 * states have to be told apart at a glance, and hue is what does that.
 */
export function hue(hex: string): number {
    const [r, g, b] = parseHex(hex).map(c => c / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) return 0;
    const degrees = max === r
        ? 60 * (((g - b) / delta) % 6)
        : max === g
            ? 60 * ((b - r) / delta + 2)
            : 60 * ((r - g) / delta + 4);
    return (degrees + 360) % 360;
}

/** The shorter way round the colour wheel between two hues, 0–180. */
export function hueDistance(a: string, b: string): number {
    const apart = Math.abs(hue(a) - hue(b)) % 360;
    return Math.round(Math.min(apart, 360 - apart));
}
