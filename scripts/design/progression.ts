/**
 * The game's progression tables, in TypeScript, for the page generator.
 *
 * scope-core.js is the runtime copy and cannot be imported by the build (it is a browser script). A
 * test asserts the two agree, so the page prints what the game actually awards rather than a
 * description of it that drifts.
 */
export interface XpAward {
    id: string;
    xp: number;
    why: string;
    repeats?: boolean;
}

export const XP_AWARDS: ReadonlyArray<XpAward> = [
    { id: "completed-run", xp: 40, why: "Finishing a run, however it ends" },
    { id: "mission-cleared", xp: 25, why: "Each mission you clear in that run", repeats: true },
    { id: "perfect-mission", xp: 35, why: "Clearing a mission without losing a life or missing a shot", repeats: true },
    { id: "new-high-score", xp: 50, why: "Beating your own best score" },
    { id: "first-track", xp: 20, why: "Tracking your first game" }
];

export interface Achievement {
    id: string;
    title: string;
    how: string;
}

export const ACHIEVEMENTS: ReadonlyArray<Achievement> = [
    { id: "first-run", title: "First contact", how: "Finish a run." },
    { id: "all-missions", title: "Full rotation", how: "Clear all five missions in one run." },
    { id: "combo-cap", title: "Unbroken", how: "Reach the maximum combo of ×8." },
    { id: "clean-hands", title: "Clean hands", how: "Clear at least one mission in a run without hitting a civilian or a hostage." },
    { id: "sharpshooter", title: "Sharpshooter", how: "Finish a run at 80% accuracy or better, over at least 15 shots." },
    { id: "perfectionist", title: "Perfectionist", how: "Clear a mission without losing a life or missing a shot." }
];
