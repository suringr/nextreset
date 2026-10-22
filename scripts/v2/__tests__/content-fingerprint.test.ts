import test from "node:test";
import assert from "node:assert/strict";
import { contentFingerprint, hashText } from "../fetch/text";

const ARTICLE = "Patch Schedule 26.19 September 23, 2026 26.20 October 7, 2026 26.21 October 21, 2026 26.22 November 4, 2026";

test("with no marker, or none present, the fingerprint is the full-text hash", () => {
    const text = `${ARTICLE} Related Articles Arena FAQ`;
    assert.equal(contentFingerprint(text), hashText(text));
    assert.equal(contentFingerprint(text, []), hashText(text));
    assert.equal(contentFingerprint(text, ["Not On This Page"]), hashText(text));
    assert.equal(contentFingerprint(text, [""]), hashText(text), "an empty marker cuts nothing");
});

test("text after a trailing marker does not count; text before it always does", () => {
    const a = `${ARTICLE} Related Articles Arena FAQ Emotes`;
    const b = `${ARTICLE} Related Articles Missions League Classic`;
    assert.equal(contentFingerprint(a, ["Related Articles"]), contentFingerprint(b, ["Related Articles"]));
    assert.equal(contentFingerprint(a, ["Related Articles"]), hashText(ARTICLE));
    const edited = a.replace("November 4", "November 5");
    assert.notEqual(contentFingerprint(edited, ["Related Articles"]), contentFingerprint(a, ["Related Articles"]));
});

test("a marker in the first half of the text is navigation, not a tail, and cuts nothing", () => {
    const text = `Related Articles ${ARTICLE} ${ARTICLE}`;
    assert.equal(contentFingerprint(text, ["Related Articles"]), hashText(text));
});

test("the last occurrence is the one that cuts, and the earliest qualifying marker wins", () => {
    const text = `${ARTICLE} Related Articles appears in the body ${ARTICLE} Related Articles tail`;
    assert.equal(contentFingerprint(text, ["Related Articles"]), hashText(text.slice(0, text.lastIndexOf("Related Articles")).trimEnd()));
    const two = `${ARTICLE} ${ARTICLE} Still have questions? Related Articles tail`;
    assert.equal(contentFingerprint(two, ["Related Articles", "Still have questions?"]), hashText(`${ARTICLE} ${ARTICLE}`));
});
