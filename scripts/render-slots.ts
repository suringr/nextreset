/**
 * The places a renderer writes into, named once.
 *
 * A tracker page has seven of them — the headline's label and value, the source, the confidence, the
 * verification rows, the note, and the block of everything else the game has verified — and the
 * homepage has one region holding every card. Until now each was addressed by pasting a copy of the
 * authored markup into the renderer and matching it exactly, which meant the renderer broke whenever
 * the page was edited and the page could not be redesigned without rewriting the renderer.
 *
 * Here each slot is named, and a name is resolved two ways:
 *
 *   1. `data-nr-slot="source"` on the element — what a page says about itself, and what the V4
 *      templates will carry.
 *   2. A structural fallback for the pages authored before slots existed: the span with id `source`,
 *      the div whose class is `countdown-value`, and so on.
 *
 * The fallback exists so this change publishes exactly the bytes the previous renderer published. It
 * is not a permanent second way of doing things: once every template declares its slots, the fallback
 * stops being reached, and a page missing a slot fails the build the same way drift always has.
 *
 * What has not changed: a slot that is missing, or present twice, throws. Publishing a page with a
 * placeholder still where a value belongs is the failure this whole pipeline exists to prevent, and
 * loosening how a slot is found must not loosen what happens when it is not found.
 */
import { ElementMatch, findByAttribute, findElements, hasClass, spliceElement } from "./html-elements";

/** The attribute a template uses to declare a slot. */
export const SLOT_ATTRIBUTE = "data-nr-slot";

/** The attribute that hands a renderer everything inside an element. */
export const REGION_ATTRIBUTE = "data-nr-region";

export type SlotName =
    | "next-drop"
    | "answer-label"
    | "answer-value"
    | "source"
    | "confidence"
    | "meta-rows"
    | "notes"
    | "verified-data";

interface SlotDefinition {
    /** Matches the element on a page that does not yet declare its slots. */
    legacy: (name: string, attributes: Record<string, string>) => boolean;
    /** A further test for a slot whose opening tag alone does not identify it. */
    contains?: (element: ElementMatch) => boolean;
    /** What the slot is, for the error a failed lookup raises. */
    describe: string;
}

const SLOTS: Record<SlotName, SlotDefinition> = {
    // The homepage's lead block. It has no pre-V4 shape to fall back to: the homepage never had one,
    // so the page must declare the slot and a page that does not fails rather than silently losing it.
    "next-drop": {
        legacy: () => false,
        describe: "the lead block the page opens with"
    },
    "answer-label": {
        legacy: (name, attributes) => name === "div" && hasClass(attributes, "countdown-label"),
        describe: "the label above the headline value"
    },
    "answer-value": {
        legacy: (name, attributes) => name === "div" && hasClass(attributes, "countdown-value"),
        describe: "the headline value"
    },
    source: {
        legacy: (name, attributes) => name === "span" && attributes.id === "source",
        describe: "the source attribution"
    },
    confidence: {
        legacy: (name, attributes) => name === "span" && attributes.id === "confidence",
        describe: "the confidence badge"
    },
    "meta-rows": {
        // The authored pages ship one row, "Last Updated", which the renderer expands into the two
        // separate facts (verified, checked) plus precision and status. It is identified by the id the
        // row it replaces carries, because "the info-row containing #last-updated" is the only thing
        // that distinguishes it from the rows above it.
        legacy: (name, attributes) => name === "div" && hasClass(attributes, "info-row"),
        contains: element => findElements(element.inner, (name, attributes) => name === "span" && attributes.id === "last-updated").length > 0,
        describe: "the verification rows"
    },
    notes: {
        legacy: (name, attributes) => name === "div" && attributes.id === "notes",
        describe: "the note beneath the headline"
    },
    "verified-data": {
        legacy: (name, attributes) => name === "div" && attributes.id === "verified-data",
        describe: "the verified-data block"
    }
};

/** Raised when a page cannot supply a slot, so the build stops instead of publishing a placeholder. */
export class SlotError extends Error {}

/**
 * Where a named slot is in this page.
 *
 * Exactly one, or the build fails: none means the page can no longer be rendered, and two means the
 * renderer would have to guess which one the reader sees.
 */
export function locateSlot(html: string, slot: SlotName, page = "page"): ElementMatch {
    const definition = SLOTS[slot];
    const declared = findByAttribute(html, SLOT_ATTRIBUTE, slot);
    const found = declared.length > 0
        ? declared
        : findElements(html, definition.legacy).filter(element => !definition.contains || definition.contains(element));

    if (found.length !== 1) {
        throw new SlotError(`${page}: expected exactly one "${slot}" slot (${definition.describe}), found ${found.length}`);
    }
    return found[0];
}

/**
 * Rewrites one slot.
 *
 * `build` receives the element it is replacing, because two of the slots need something from it: the
 * verification rows reuse the element's indentation for the rows they add, and a slot with nothing to
 * say returns the element's own source to leave the page exactly as it was.
 */
export function replaceSlot(html: string, slot: SlotName, build: (element: ElementMatch) => string, page = "page"): string {
    const element = locateSlot(html, slot, page);
    return spliceElement(html, element, build(element));
}

/** Where the cards live, and whether the renderer owns everything inside that range. */
export interface CardRegion {
    /** Offset the replacement starts at. */
    start: number;
    /** Offset the replacement ends at. */
    end: number;
    /**
     * Whether the page handed the renderer a container of its own.
     *
     * When it did, everything between the container's tags belongs to the renderer, so headings,
     * shelves and group wrappers can be emitted freely. When it did not — the homepage as authored
     * before V4 — the range spans the first card to the last, and anything found between two cards is
     * content the rewrite would destroy, so it throws.
     */
    owned: boolean;
    /** The indentation of the container or of the first card, for whatever the renderer emits. */
    indent: string;
}

/**
 * The region of a page the card renderer may rewrite.
 *
 * `cards` is supplied by the caller rather than found here, because which anchors count as cards is
 * the homepage renderer's business; this decides only how much of the page it is allowed to replace.
 */
export function cardRegion(html: string, cards: Array<{ block: string; index: number }>, page = "home"): CardRegion {
    const containers = findByAttribute(html, REGION_ATTRIBUTE, "cards");
    if (containers.length > 1) {
        throw new SlotError(`${page}: expected at most one "cards" region, found ${containers.length}`);
    }
    if (containers.length === 1) {
        const container = containers[0];
        // Owning the region is permission to emit headings and wrappers between cards — not permission
        // to delete whatever else was put there. Anything that is not a card, a card's slot or a group
        // heading would be destroyed by the rewrite, so it stops the build exactly as it did when the
        // region was only the span between the first card and the last.
        const stray = findElements(container.inner, (name, attributes) =>
            !hasClass(attributes, "card") && !hasClass(attributes, "card-slot") && !hasClass(attributes, "group-heading")
        ).filter(element => {
            // Only what sits at the top of the region: everything inside a card is the card's business.
            const enclosing = findElements(container.inner, (_n, a) => hasClass(a, "card") || hasClass(a, "card-slot") || hasClass(a, "group-heading"));
            return !enclosing.some(owner => element.start > owner.start && element.end <= owner.end);
        });
        if (stray.length > 0) {
            throw new SlotError(`${page}: unexpected content between cards: ${JSON.stringify(stray[0].source.trim().slice(0, 60))}`);
        }

        // Measured from the element's own parts rather than from the length of a closing tag we assume
        // was written `</div>`: `</div >` is the same tag and would put the end one byte short.
        const start = container.start + container.openTag.length;
        return { start, end: start + container.inner.length, owned: true, indent: container.indent };
    }

    if (cards.length === 0) throw new SlotError(`${page}: no cards found`);
    const first = cards[0];
    const last = cards[cards.length - 1];
    for (let i = 1; i < cards.length; i++) {
        const between = html.slice(cards[i - 1].index + cards[i - 1].block.length, cards[i].index);
        if (between.trim() !== "") {
            throw new SlotError(`${page}: unexpected content between cards: ${JSON.stringify(between.trim().slice(0, 60))}`);
        }
    }
    return { start: first.index, end: last.index + last.block.length, owned: false, indent: "" };
}
