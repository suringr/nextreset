/**
 * ONE SHOT // 80 CONTRACTS — the facts about the game the build needs, in one place.
 *
 * The game itself is `public/assets/one-shot.js`, a browser script the build cannot import. What the
 * page generator, the shared header and the tests need from it is small, and it is written here once:
 * the name, the size of the campaign, and the rank ladder. `one-shot.test.ts` holds each of these to the
 * approved prototype and to the runtime copies in `one-shot.js` and `player.js`.
 */

/** The game's name, as the approved prototype writes it in its header. */
export const ONE_SHOT_NAME = "ONE SHOT // 80 CONTRACTS";

/** Eighty contracts, in eight chapters of ten. */
export const ONE_SHOT_CONTRACTS = 80;

/** The ranks, one every 8,000 XP, in the game's order and spelling. */
export const ONE_SHOT_RANKS: ReadonlyArray<string> = [
    "Recruit", "Rookie", "Marksman", "Sharpshooter", "Hunter", "Operative", "Elite", "Ghost", "Master Sniper"
];
export const ONE_SHOT_RANK_XP = 8000;
