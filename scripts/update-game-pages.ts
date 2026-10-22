import * as fs from 'fs';
import * as path from 'path';
import { ADSENSE_LOADER } from './adsense';
import { footerRowHtml } from './design/chrome';
import { isListed } from './indexing';

/**
 * The tracker registry, the footer navigation, and a page template that is no longer the page.
 *
 * `gamePages` below is the source of truth for which trackers exist, what each one is called, and the
 * per-game copy each page carries. It is imported by the tests and by the footer navigation, and that is
 * what this module is for in practice.
 *
 * ⚠ `generatePage` and the `require.main` block beneath it are STALE and must not be run. They were the
 * original generator, and the published pages have moved on without them: the shared chrome header, the
 * player chip, `player.js`, the inline critical CSS and the versioned asset URLs all arrived in later
 * work that writes into the authored pages directly. Running `node build/update-game-pages.js` today
 * would overwrite all twelve tracker pages with markup that predates the approved design, silently
 * undoing it. There is deliberately no npm script for it.
 *
 * Changes to the authored pages are therefore made in `public/` (or by a targeted script), and anything
 * this template says about their markup should be read as history. Rebuilding the generator so it
 * reproduces the current pages byte for byte is worth doing, and is its own piece of work.
 */

const publicDir = path.join(__dirname, '../public');

export interface FaqItem {
    q: string;
    a: string;
}

export interface GamePage {
    path: string;
    game: string;
    type: string;
    typeTitle: string;
    title: string;
    kicker: string;
    /** One line for the homepage's list of trackers: what it tracks and where the value comes from. */
    listSummary: string;
    metaDescription: string;
    aboutTracker: string;
    whatIsIt: string;
    whatChanges: string[];
    faq: FaqItem[];
}

export const gamePages: GamePage[] = [
    {
        path: 'fortnite/next-season/index.html',
        game: 'fortnite',
        type: 'next-season',
        typeTitle: 'Season End',
        title: 'Fortnite',
        kicker: 'Battle Royale',
        listSummary: 'Season end, from Epic’s Battle Pass page; no date is shown while that page refuses our checks',
        metaDescription: "Fortnite season end, read from Epic's official Battle Pass page - a source that began refusing our servers in April 2026. What that means, and what a season change brings.",
        aboutTracker: 'This page tracks the end date of the current Fortnite Battle Pass season, read from the official Battle Pass page on fortnite.com. On 5 April 2026 that source began refusing requests from our servers. While it refuses, this page shows no date rather than an estimate.',
        whatIsIt: 'Every few months, Epic Games launches a new Fortnite season with a completely refreshed Battle Pass, new map changes, fresh weapons, and unique gameplay mechanics. Each season typically lasts 10-13 weeks and introduces a new theme that reshapes the entire game experience. Knowing when the current season ends helps you plan your remaining Battle Pass challenges and prepare for whatever comes next.',
        whatChanges: [],
        faq: [
            { q: "Why does this page sometimes show no season end date?", a: 'Because the only sources we accept are Epic\'s own, and on 5 April 2026 they began answering our servers with an HTTP 403 challenge rather than a page. We do not work around that challenge, and we do not take season dates from community trackers or unofficial API mirrors, accurate though those often are. When Epic\'s page answers, the date appears here; when it does not, we would rather show nothing than a guess.' },
            { q: 'What happens when a Fortnite season ends?', a: 'When a season ends, your Battle Pass progress resets, the map typically changes, and a new set of weapons and items are introduced. Any unearned Battle Pass rewards from the previous season become unavailable.' },
            { q: 'Where can I see the official season end date?', a: 'Epic shows the current season\'s end date on the Battle Pass screen inside Fortnite itself, and announces season changes on fortnite.com. Those are the authoritative places. We would rather point you to them than restate a date we cannot verify.' }
        ]
    },
    {
        path: 'lol/next-patch/index.html',
        game: 'lol',
        type: 'next-patch',
        typeTitle: 'Next Patch',
        title: 'League of Legends',
        kicker: 'MOBA',
        listSummary: 'Next patch, from Riot’s published patch schedule',
        metaDescription: 'The next League of Legends patch date, read from Riot\'s published patch schedule, with the patches before and after it. Riot gives a day for each patch, not a time.',
        aboutTracker: 'This page shows the next scheduled League of Legends patch, read from the patch schedule Riot publishes on its support site. Riot lists a day for each patch rather than a time, so a day is what this page shows. The schedule is read with the help of a language model, and a date is published only when the text it came from appears word for word on Riot\'s page.',
        whatIsIt: 'League of Legends runs on roughly a two-week patch cycle, give or take a few days, with longer breaks at a couple of points in the year. Each patch brings balance changes to champions, items, and runes, along with occasional new features, visual updates, and gameplay adjustments. Riot Games publishes their patch schedule at the start of each season, making LoL one of the most predictable games to track.',
        whatChanges: [],
        faq: [
            { q: 'How often does League of Legends get patched?', a: 'About every two weeks. Riot publishes the full year’s schedule in advance, which is where the dates on this page come from, so the next one is usually known well ahead. The cycle is not rigid, though: the published gaps vary by a day or two either way, and stretch to about three weeks around breaks.' },
            { q: 'What time do LoL patches go live?', a: 'Riot’s annual patch schedule gives a day rather than a time, so a day is what this page publishes — putting a clock on it would mean inventing one. Riot does announce the deployment window closer to the day, on its service status page, with the hour for each region and how long the game will be unavailable.' },
            { q: 'Where can I read the patch notes?', a: 'Official patch notes are published on the League of Legends website at leagueoflegends.com and are usually available the day before the patch deploys.' }
        ]
    },
    {
        path: 'valorant/last-patch/index.html',
        game: 'valorant',
        type: 'last-patch',
        typeTitle: 'Last Patch',
        title: 'VALORANT',
        kicker: 'Tactical Shooter',
        listSummary: 'Latest patch, from Riot’s patch notes on playvalorant.com',
        metaDescription: 'When the latest VALORANT patch notes were published, read from Riot\'s game updates on playvalorant.com, with the patches before it.',
        aboutTracker: 'This page shows when the most recent VALORANT patch notes were published, read from Riot\'s game updates page on playvalorant.com. The time is the publication time Riot gives each article.',
        whatIsIt: 'VALORANT receives regular patches from Riot Games that adjust agent abilities, weapon balance, and map rotations. Riot does not publish VALORANT patch dates in advance, and the gap from one patch to the next varies; the list on this page shows the dates Riot actually published.',
        whatChanges: [],
        faq: [
            { q: 'How often does VALORANT get updated?', a: 'Riot does not publish a fixed VALORANT schedule, and the gaps between patches vary. The patches listed on this page are the ones Riot has published, with their dates, so the gaps can be read directly rather than taken from us.' },
            { q: 'Where are the VALORANT patch notes?', a: 'On playvalorant.com, under Game Updates. Each patch listed on this page links to its own article there.' },
            { q: 'Is the time on this page when the patch went live?', a: 'It is when Riot published the patch notes on playvalorant.com, the time the article itself carries. This page does not track when a patch reaches each region\'s servers.' }
        ]
    },
    {
        path: 'cs2/last-update/index.html',
        game: 'cs2',
        type: 'last-update',
        typeTitle: 'Last Update',
        title: 'Counter-Strike 2',
        kicker: 'Tactical Shooter',
        listSummary: 'Latest update, from Valve’s update posts on Steam',
        metaDescription: 'When the latest Counter-Strike 2 update was published, read from Valve\'s update posts on Steam, with the updates before it.',
        aboutTracker: 'This page shows the most recent Counter-Strike 2 update, read from the "Counter-Strike 2 Update" posts Valve publishes in the game\'s Steam news feed. The time shown is when Valve published the post.',
        whatIsIt: 'Counter-Strike 2 receives periodic updates from Valve that can include everything from major gameplay changes to small balance tweaks. Unlike games with fixed patch schedules, CS2 updates arrive on Valve\'s own timeline — sometimes weekly, sometimes with longer gaps between releases. Each update is documented on the official Counter-Strike website with detailed release notes.',
        whatChanges: [],
        faq: [
            { q: 'How often does CS2 get updated?', a: 'Valve does not follow a fixed schedule. It ships updates when they are ready — sometimes several in a week, sometimes with gaps of two weeks or more — and does not announce them in advance, so there is no next date to show.' },
            { q: 'Where are the CS2 patch notes?', a: 'Valve posts them on Steam and on counter-strike.net. Each update listed on this page links to its Steam post.' },
            { q: 'Do CS2 updates require a game restart?', a: 'Yes. Steam downloads new versions on its own, and the game has to be restarted to run one.' }
        ]
    },
    {
        path: 'minecraft/last-release/index.html',
        game: 'minecraft',
        type: 'last-release',
        typeTitle: 'Last Release',
        title: 'Minecraft',
        kicker: 'Sandbox',
        listSummary: 'Latest Java Edition release, from Mojang’s launcher version manifest',
        metaDescription: 'The latest Minecraft: Java Edition release and its release time, read from the version manifest Mojang\'s launcher uses, with the releases before it.',
        aboutTracker: 'This page shows the most recent Minecraft: Java Edition release, read from the version manifest that the official Minecraft Launcher uses. The time is the release time Mojang records there; each release links to Mojang\'s changelogs, where the patch notes are.',
        whatIsIt: 'Since 2026 Mojang numbers Java Edition releases by year (26.1, 26.2, 26.3, with point releases such as 26.1.1); releases before that were numbered 1.21.x. Larger updates introduce large new features like biomes, mobs, and gameplay mechanics, while point releases focus on bug fixes and stability improvements. Mojang typically releases one or two major updates per year, with snapshots and pre-releases available for testing beforehand.',
        whatChanges: [],
        faq: [
            { q: 'How often does Minecraft get updated?', a: 'Since 2026 Mojang has shipped several numbered Java Edition releases a year rather than one or two large ones, with point releases for fixes between them. The release list on this page shows each one with its date.' },
            { q: 'Why are snapshots and pre-releases not listed?', a: 'They are test builds. This page follows stable Java Edition releases only — the ones the launcher offers as "Latest release" — using the release time Mojang records in its own launcher manifest, exact to the second.' },
            { q: 'Do I need to update manually?', a: 'No. The official Minecraft Launcher downloads the latest release by itself, and its version selector lets you play an older one.' }
        ]
    },
    {
        path: 'roblox/status/index.html',
        game: 'roblox',
        type: 'status',
        typeTitle: 'Status',
        title: 'Roblox',
        kicker: 'Platform',
        listSummary: 'Overall service status, from the feed behind status.roblox.com',
        metaDescription: 'The Roblox service status as Roblox\'s own status page last reported it, and when that status last changed.',
        aboutTracker: 'This page shows the overall Roblox service status, read several times a day from the feed behind status.roblox.com, and when that status last changed. For the minute-by-minute answer, status.roblox.com itself is the place to look.',
        whatIsIt: 'Roblox is a platform hosting millions of user-created games and experiences. Service outages can affect millions of players worldwide, making status monitoring essential. This tracker checks the official Roblox status page to show you whether the platform is fully operational, experiencing degraded performance, or completely down.',
        whatChanges: [],
        faq: [
            { q: 'Is Roblox down right now?', a: 'This page shows what Roblox\'s own status feed said when it was last checked, several times a day. For the current minute, status.roblox.com is the source this page reads.' },
            { q: 'What does "Operational" mean?', a: 'It is Roblox\'s own word for the state where no service has a reported problem. When something is wrong, Roblox\'s status page names the affected services and the status changes.' }
        ]
    },
    {
        path: 'gta/weekly-reset/index.html',
        game: 'gta',
        type: 'weekly-reset',
        typeTitle: 'Weekly Reset',
        title: 'GTA Online',
        kicker: 'Open World',
        listSummary: 'Weekly reset, computed from the Thursday 10:00 UTC rule',
        metaDescription: 'Track the next GTA Online weekly reset countdown. Every Thursday at 10:00 UTC, Rockstar refreshes bonuses, discounts, and challenges.',
        aboutTracker: 'This page shows the next GTA Online weekly reset. It is computed from a fixed weekly rule, every Thursday at 10:00 UTC, rather than read from a Rockstar page, so there is no announcement behind each date to check it against.',
        whatIsIt: 'Every Thursday at 10:00 UTC (6:00 AM in New York during daylight saving time, 5:00 AM otherwise), Rockstar Games refreshes GTA Online with new weekly content. This rotation has been a core part of GTA Online for years and gives players a reason to check in every week. The weekly reset brings new discounts, bonus payouts, and featured content that changes the best way to earn money and experience in the game.',
        whatChanges: [],
        faq: [
            { q: 'What time does GTA Online reset each week?', a: 'GTA Online resets every Thursday at exactly 10:00 UTC. In New York that is 6:00 AM while daylight saving is in effect and 5:00 AM once the clocks go back; in Los Angeles, 3:00 AM and then 2:00 AM. UTC does not shift, so the reset itself never moves - only your offset from it does.' },
            { q: 'What changes during the GTA Online weekly reset?', a: 'The week\'s discounts, bonus payouts and featured activities. Rockstar lists each week\'s changes in its Newswire post for that week; this page tracks when the reset happens, not what it contains.' },
            { q: 'Do I lose anything during the weekly reset?', a: 'No. Your character\'s progress, money, vehicles and properties are not affected; only the featured content and discounts change.' }
        ]
    },
    {
        path: 'warzone/last-patch/index.html',
        game: 'warzone',
        type: 'last-patch',
        typeTitle: 'Last Patch',
        title: 'Warzone',
        kicker: 'Battle Royale',
        listSummary: 'Latest patch date, from the Call of Duty patch notes page',
        metaDescription: 'The date of the latest Call of Duty: Warzone patch notes, read from callofduty.com, with the patches before it. Activision gives a date, not a time.',
        aboutTracker: 'This page tracks the most recent Call of Duty Warzone patch release. Data is sourced from the official Call of Duty patch notes page at callofduty.com.',
        whatIsIt: 'Call of Duty: Warzone receives regular patches and updates from Activision and Raven Software that adjust weapon balance, fix bugs, and occasionally introduce new content. Warzone updates are typically synchronized with the broader Call of Duty ecosystem, meaning updates often affect both Warzone and the current mainline Call of Duty title simultaneously.',
        whatChanges: [],
        faq: [
            { q: 'How often does Warzone get updated?', a: 'Activision does not publish a schedule. Each season opens with a large update and a "Reloaded" update arrives partway through, with smaller patches in between; the list on this page gives the date of each one, so the gaps can be read directly.' },
            { q: 'Why does this page show a date but no time?', a: 'Activision\'s patch notes page dates each patch but gives no time of day. A time would be ours, not Activision\'s, so the page shows the date alone.' },
            { q: 'Where are the Warzone patch notes?', a: 'On callofduty.com/patchnotes. Each patch listed on this page links to its notes there.' }
        ]
    },
    {
        path: 'genshin/next-banner/index.html',
        game: 'genshin',
        type: 'next-banner',
        typeTitle: 'Next Banner End',
        title: 'Genshin Impact',
        kicker: 'Action RPG',
        listSummary: 'Banner phase end for each server region, from HoYoverse’s in-game announcements',
        metaDescription: 'When the current Genshin Impact banner phase ends, read from HoYoverse\'s in-game announcements, with the exact time for the Asia, Europe and America servers.',
        aboutTracker: 'This page shows when the current Genshin Impact event wish (banner) phase ends, read from HoYoverse\'s official in-game announcements for the Asia, Europe and America servers. Each region reaches the same server time at a different moment, so each gets its own UTC time.',
        whatIsIt: 'Genshin Impact uses a gacha system where limited-time character and weapon banners rotate every few weeks. Each banner features specific 5-star and 4-star characters that may not return for months. Knowing when a banner ends is critical for players deciding whether to spend their Primogems now or save for an upcoming character they want more.',
        whatChanges: [],
        faq: [
            { q: 'When does the current Genshin banner end?', a: 'Each version has two banner phases, and a phase typically runs about three weeks. HoYoverse announces the end of a phase in its official in-game announcements; where this tracker has read and verified one, it gives the exact UTC instant for each of the three server regions, because they reach the same local time at different moments.' },
            { q: 'Why are there three different end times?', a: 'A phase ends at the same server time in every region, and the Asia, Europe and America servers keep different time zones. The same server time is therefore three different moments in UTC, and the page gives each one.' },
            { q: 'Does my pity reset when the banner changes?', a: 'No. Pity carries over between banners of the same type: if you are at 70 pulls on one character event wish, you will still be at 70 when the next one starts.' }
        ]
    },
    {
        path: 'pubg/last-patch/index.html',
        game: 'pubg',
        type: 'last-patch',
        typeTitle: 'Last Patch',
        title: 'PUBG',
        kicker: 'Battle Royale',
        listSummary: 'Latest patch, from KRAFTON’s patch-notes posts on Steam',
        metaDescription: 'When the latest PUBG: BATTLEGROUNDS patch notes were published, read from KRAFTON\'s posts on Steam, with the patches before it.',
        aboutTracker: 'This page shows the most recent PUBG: BATTLEGROUNDS patch, read from the "Patch Notes - Update" posts KRAFTON publishes in the game\'s Steam news feed. The time shown is when KRAFTON published the post.',
        whatIsIt: 'PUBG: Battlegrounds receives regular updates from KRAFTON that introduce balance changes, new content, and gameplay improvements. PUBG follows a seasonal update model with major patches at the start of each season and smaller fix patches throughout. Each major update can bring new weapons, vehicles, map changes, and quality-of-life improvements to the battle royale experience.',
        whatChanges: [],
        faq: [
            { q: 'How often does PUBG get patched?', a: 'KRAFTON does not publish a fixed schedule, but its patches have come at regular intervals. The reset times page gives the typical gap, measured from the patches listed here rather than estimated. Season starts bring the larger updates; the ones in between are usually fixes.' },
            { q: 'Where are the PUBG patch notes?', a: 'KRAFTON posts them on Steam and on pubg.com. Each patch listed on this page links to its Steam post.' },
            { q: 'Is the time on this page when the update went live?', a: 'It is when KRAFTON published the patch notes on Steam, the time the post itself carries. This page does not track server maintenance windows.' }
        ]
    },
    {
        path: 'red-dead-redemption-2/last-update/index.html',
        game: 'red-dead-redemption-2',
        type: 'last-update',
        typeTitle: 'Last Update',
        title: 'Red Dead Redemption 2',
        kicker: 'Open World',
        listSummary: 'Latest Red Dead Redemption 2 news, from Rockstar’s Newswire',
        metaDescription: 'Track the latest Red Dead Redemption 2 and Red Dead Online update from Rockstar Games Newswire.',
        aboutTracker: 'This page tracks the most recent official Red Dead Redemption 2 news from Rockstar Games. Data is sourced from the Rockstar Newswire, which serves as the primary communication channel for all Rockstar game updates.',
        whatIsIt: 'Red Dead Redemption 2 and Red Dead Online receive periodic updates from Rockstar Games, though less frequently than GTA Online. Updates can include bug fixes, stability improvements, and occasional content additions for Red Dead Online. While Rockstar has shifted much of their focus to GTA, the Newswire still serves as the official source for any Red Dead-related announcements.',
        whatChanges: [],
        faq: [
            { q: 'Does Red Dead Redemption 2 still get updates?', a: 'Updates have become less frequent, but Rockstar occasionally releases fixes and minor content. This tracker monitors the Rockstar Newswire for the latest official news.' },
            { q: 'Is Red Dead Online still active?', a: 'Red Dead Online still has an active player community, though Rockstar has significantly reduced new content updates compared to its early years. Existing activities and modes remain fully playable.' },
            { q: 'Where does Rockstar announce Red Dead updates?', a: 'All official announcements come through the Rockstar Newswire at rockstargames.com/newswire. This is the source our tracker monitors.' }
        ]
    },
    {
        path: 'ea-sports-fc/last-title-update/index.html',
        game: 'ea-sports-fc',
        type: 'last-title-update',
        typeTitle: 'Last Title Update',
        title: 'EA SPORTS FC',
        kicker: 'Sports',
        listSummary: 'Latest title update, from EA’s update posts on Steam',
        metaDescription: 'When the latest EA SPORTS FC title update was announced, read from EA\'s update posts on Steam for each title year, with the updates before it.',
        aboutTracker: 'This page shows the most recent EA SPORTS FC title update, read from the announcement posts EA publishes on Steam for each title year. The time shown is when EA published the post. EA\'s Forums answer automated requests with a challenge and are not used.',
        whatIsIt: 'EA SPORTS FC (formerly FIFA) receives regular title updates throughout its annual cycle. These updates address gameplay balance, fix bugs, and occasionally introduce new features. Title updates are the primary way EA Sports tunes the game after launch, adjusting everything from player movement and shooting mechanics to goalkeeper AI and set-piece behavior.',
        whatChanges: [],
        faq: [
            { q: 'How often does EA SPORTS FC get title updates?', a: 'EA does not publish a schedule. It ships title updates when they are ready, so there is no next date until EA names one. The list on this page shows each title update EA has posted, with its date.' },
            { q: 'Which game year does this page follow?', a: 'Both EA SPORTS FC 26 and FC 27 while both receive updates. Each title year has its own Steam announcements, and the page shows whichever update is most recent.' },
            { q: 'Do title updates affect Ultimate Team?', a: 'Yes. Title updates can change gameplay in every mode, Ultimate Team included. New promos, SBCs and objectives are separate content updates made on EA\'s servers.' }
        ]
    }
];

// Generate JSON-LD FAQ schema
function generateFaqSchema(faq: FaqItem[]): string {
    const items = faq.map(item => `{
          "@type": "Question",
          "name": ${JSON.stringify(item.q)},
          "acceptedAnswer": {
            "@type": "Answer",
            "text": ${JSON.stringify(item.a)}
          }
        }`);

    return `<script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        ${items.join(',\n        ')}
      ]
    }
    </script>`;
}

/**
 * Where this page sits, for a reader and for a crawler.
 *
 * Two levels, not three: there is no per-game page to point at, and a breadcrumb that links to one
 * that does not exist would be worse than none. The last crumb carries no URL, which is how Google
 * expects the current page to appear.
 */
function breadcrumbHtml(page: GamePage): string {
    return `<nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="/">Home</a>
        <span class="crumb-sep" aria-hidden="true">›</span>
        <span aria-current="page">${page.title}: ${page.typeTitle}</span>
      </nav>`;
}

function breadcrumbSchema(page: GamePage): string {
    return `<script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": "Home",
          "item": "https://nextreset.co/"
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": ${JSON.stringify(`${page.title}: ${page.typeTitle}`)}
        }
      ]
    }
    </script>`;
}

/**
 * Every tracker worth reading, in the footer of every page that has a footer.
 *
 * Each page was previously reachable only from the homepage. Linking them to each other means a reader
 * who lands on one can reach the rest, and the anchor text says what each one answers rather than
 * repeating the game's name alone. The current page is named but not linked.
 *
 * Trackers withheld from the index (see `EDITORIAL_NOINDEX`) are left out. A footer link from all
 * fifteen pages to a page we are asking Google not to index is fifteen invitations to the page we think
 * is worth the least — and for a reader it is fifteen chances to click through to the one tracker that
 * cannot answer its question. The route still works, the homepage still shows its card, and `/resets/`
 * can still carry its row; it just is not advertised as somewhere to go.
 */
export function footerNavHtml(pages: GamePage[], current?: GamePage): string {
    const items = pages.filter(page => isListed(page.path)).map(page => {
        const label = `${page.title} — ${page.typeTitle.toLowerCase()}`;
        return page === current
            ? `        <span aria-current="page">${label}</span>`
            : `        <a href="/${page.game}/${page.type}/">${label}</a>`;
    });
    return `<nav class="footer-nav" aria-label="Trackers">
${items.join('\n')}
      </nav>`;
}

// Generate HTML for a game page
function generatePage(page: GamePage): string {
    const faqHtml = page.faq.map(item =>
        `<details class="faq-item">
              <summary>${item.q}</summary>
              <p>${item.a}</p>
            </details>`
    ).join('\n            ');

    const changesHtml = page.whatChanges.map(c => `<li>${c}</li>`).join('\n              ');

    const faqSchema = generateFaqSchema(page.faq);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="description" content="${page.metaDescription}">
  <meta property="og:title" content="${page.title} ${page.typeTitle} - NextReset">
  <meta property="og:description" content="${page.metaDescription}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://nextreset.co/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <link rel="canonical" href="https://nextreset.co/${page.game}/${page.type}/">
  <title>${page.title} ${page.typeTitle} - NextReset</title>
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/favicon.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#0b0f14">

  <!-- CRITICAL: Inline CSS for guaranteed first paint -->
  <style>
    body{margin:0;background:#0b0f14;color:#e5e7eb;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
    .container{max-width:980px;margin:0 auto;padding:22px}
    .game-page{max-width:720px;margin:0 auto}
    .game-title{font-size:42px;font-weight:900;margin:0 0 12px}
    .countdown-box{background:#111827;border:1px solid #1f2937;border-radius:18px;padding:48px 32px;text-align:center;margin:32px 0}
    .countdown-label{color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:.14em;font-weight:700;margin-bottom:18px}
    .countdown-value{font-size:56px;font-weight:900;color:#22c55e;line-height:1.1}
    .info-panel{background:#0f172a;border:1px solid #1f2937;border-radius:18px;padding:20px 24px;margin:24px 0}
    .info-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #1f2937}
    .info-row:last-child{border-bottom:none}
    .info-label{color:#6b7280;font-size:13px;text-transform:uppercase;font-weight:600}
    .info-value{font-weight:700}
    .content-section{margin:32px 0}
    .content-section h2{font-size:22px;font-weight:800;margin:0 0 12px;color:#e5e7eb}
    .content-section p{color:#9ca3af;line-height:1.7;margin:0 0 16px;font-size:15px}
    .content-section ul{color:#9ca3af;line-height:1.8;padding-left:20px;margin:0 0 16px}
    .content-section li{margin-bottom:4px;font-size:15px}
    .faq-item{background:#111827;border:1px solid #1f2937;border-radius:12px;margin-bottom:8px;overflow:hidden}
    .faq-item summary{padding:14px 18px;cursor:pointer;font-weight:700;font-size:15px;list-style:none;display:flex;align-items:center;gap:10px}
    .faq-item summary::before{content:'▸';color:#22c55e;font-size:14px;transition:transform .2s}
    .faq-item[open] summary::before{transform:rotate(90deg)}
    .faq-item summary::-webkit-details-marker{display:none}
    .faq-item p{padding:0 18px 14px;color:#9ca3af;line-height:1.7;margin:0;font-size:14px}
    .trust-box{background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px 20px;margin:24px 0;display:flex;gap:24px;flex-wrap:wrap}
    .trust-item{flex:1;min-width:140px}
    .trust-item .label{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:4px}
    .trust-item .value{font-weight:700;font-size:14px;color:#e5e7eb}
    @media(max-width:600px){.game-title{font-size:32px}.countdown-value{font-size:40px}.trust-box{flex-direction:column;gap:12px}}
  </style>

  <link rel="stylesheet" href="/assets/styles.v2.css">

  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
      wait_for_update: 500,
      region: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO','GB','CH']
    });
    // Denying ad_storage does not stop the ad-click id in the URL being sent with the page location, so
    // a visitor arriving on a gclid link was identifiable in the very signal the defaults were supposed
    // to have made anonymous. Redaction strips it while consent is denied, and lifts when it is granted.
    gtag('set', 'ads_data_redaction', true);
  </script>

  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YY6V5SR1DN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    // Analytics sends the page address, and ads_data_redaction does not reach it: that setting covers
    // Google Ads pings, not these fields. So an ad-click id in the URL would arrive at Google attached to
    // a visit whose consent was denied, which is the one thing the defaults were supposed to have
    // prevented. Stripped here, before the first measurement rather than in a policy footnote.
    //
    // Both fields, not only the location. The referrer is the same leak one click later: a visitor
    // landing on /x/?gclid=A and following any same-origin link hands that whole URL to the next page as
    // document.referrer, which analytics collects automatically.
    function nrClean(href) {
      try {
        var u = new URL(href);
        ['gclid', 'dclid', 'gbraid', 'wbraid', 'gclsrc', 'gad_source', 'msclkid', 'fbclid', '_gl']
          .forEach(function (p) { u.searchParams.delete(p); });
        return u.href;
      } catch (e) {
        // An address that will not parse is left alone rather than guessed at.
        return href;
      }
    }
    var nrFields = { page_location: nrClean(location.href) };
    if (document.referrer) nrFields.page_referrer = nrClean(document.referrer);
    gtag('config', 'G-YY6V5SR1DN', nrFields);
  </script>

  <!-- Google AdSense site code -->
  ${ADSENSE_LOADER}

  ${faqSchema}
  ${breadcrumbSchema(page)}
</head>
<body>
  <div class="container">
    <div class="game-page">
      <!-- The demo's tracker hero: where the page sits, its heading, and the answer, in one card. The
           answer comes straight after the heading: this page exists to answer one question. -->
      <section class="tracker-hero">
        <div class="hero-eyebrow">
          ${breadcrumbHtml(page)}
          <div class="game-meta">
            <span class="kicker">${page.kicker}</span>
          </div>
        </div>
        <h1 class="game-title" id="event-title">${page.title} ${page.typeTitle}</h1>
        <div class="countdown-box" id="countdown">
          <div class="countdown-label" data-nr-slot="answer-label">Checking official sources...</div>
          <div class="countdown-value countdown-skeleton" data-nr-slot="answer-value">--:--:--</div>
        </div>
        <!-- Tracking, from the page a search result actually lands on. A sibling of the heading, never
             inside a link, and shipped hidden because without JavaScript it would do nothing. What it
             changes is the order of the homepage grid and nothing else: no published value moves. -->
        <button type="button" class="btn track track-wide game-track" data-track="${page.game}" aria-pressed="false" hidden>
          <span class="track-mark" aria-hidden="true">☆</span>
          <span class="track-label">Track</span>
          <span class="visually-hidden">&nbsp;${page.title}</span>
        </button>
      </section>

      <!-- The demo's two columns: what the source has published, and how we know it. In the document
           the evidence comes first, straight after the answer it supports; the demo's columns put the
           published data on the left, and the stylesheet places them so. -->
      <div class="layout">
      <!-- How we know: the source, how sure the pipeline is, and the two times that are not the same
           question — when the source last confirmed the value, and when we last tried. -->
      <section class="evidence">
        <h2 class="section-heading">How we know</h2>
        <div class="info-panel">
          <div class="info-row">
            <span class="info-label">Source</span>
            <span class="info-value" id="source" data-nr-slot="source">...</span>
          </div>
          <div class="info-row">
            <span class="info-label">Confidence</span>
            <span id="confidence" class="confidence" data-nr-slot="confidence">...</span>
          </div>
          <div class="info-row" data-nr-slot="meta-rows">
            <span class="info-label">Last Updated</span>
            <span class="info-value" id="last-updated">...</span>
          </div>
        </div>

        <!-- Notes -->
        <div id="notes" class="notes" data-nr-slot="notes" style="display: none;"></div>
      </section>

      <!-- Verified data, rendered at build time from the knowledge store -->
      <div id="verified-data" data-nr-slot="verified-data"></div>
      </div>

      <!-- While you wait: the demo's arcade strip. This page exists to answer a question, and the
           arcade is what there is to do once it has. -->
      <aside class="arc">
        <div>
          <p class="eyebrow">NEXT//RESET Arcade</p>
          <p><strong>While you wait.</strong></p>
          <p class="arc-line">ONE SHOT // 80 CONTRACTS is a sniper arcade game that lives on this site.</p>
        </div>
        <a class="btn btn-primary" href="/play/">Play<span class="visually-hidden"> ONE SHOT</span></a>
      </aside>

      <!-- About -->
      <div class="content-section">
        <h2>About this tracker</h2>
        <p>${page.aboutTracker}</p>
      </div>

      <!-- What Is It -->
      <div class="content-section">
        <h2>What Is the ${page.typeTitle}?</h2>
        <p>${page.whatIsIt}</p>
      </div>

      <!-- What Changes -->
      <div class="content-section">
        <h2>What Changes</h2>
        <ul>
              ${changesHtml}
            </ul>
      </div>

      <!-- FAQ -->
      <div class="content-section">
        <h2>Frequently Asked Questions</h2>
            ${faqHtml}
      </div>

    </div>

    <noscript>
      <div class="noscript-note">
        This page shows the last verified values. JavaScript adds a live countdown for events known to the exact second.
      </div>
    </noscript>

    <footer>
      ${footerNavHtml(gamePages, page)}
${footerRowHtml('      ')}
    </footer>
  </div>

  <!-- Data attributes for JS -->
  <div id="countdown-container" data-game="${page.game}" data-type="${page.type}" style="display: none;"></div>

  <!-- Global error handlers -->
  <script>
    window.onerror = function(msg, url, lineNo, columnNo, error) {
      console.log('Error: ' + msg + '\\nScript: ' + url + '\\nLine: ' + lineNo);
      if (window.gtag) gtag('event', 'exception', { 'description': msg, 'fatal': false });
      return false;
    };
    window.addEventListener('unhandledrejection', function(event) {
      console.log('Unhandled rejection:', event.reason);
      if (window.gtag) gtag('event', 'exception', { 'description': event.reason, 'fatal': false });
    });
  </script>
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

// Write all pages. Guarded, so the registry and the footer navigation can be read by other scripts and
// by tests without rewriting twelve pages as a side effect of importing them.
if (require.main === module) {
    for (const page of gamePages) {
        const filePath = path.join(publicDir, page.path);
        const dir = path.dirname(filePath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const content = generatePage(page);
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`✓ Generated ${page.title} (${page.typeTitle})`);
    }

    console.log(`\n✅ Generated ${gamePages.length} game pages with rich content!`);
}
