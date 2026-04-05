import * as fs from 'fs';
import * as path from 'path';

/**
 * Generate all game pages with rich content for AdSense compliance.
 * Each page includes: About, What Is, What Changes, FAQ, How We Track.
 */

const publicDir = path.join(__dirname, '../public');

interface FaqItem {
    q: string;
    a: string;
}

interface GamePage {
    path: string;
    game: string;
    type: string;
    typeTitle: string;
    title: string;
    kicker: string;
    metaDescription: string;
    aboutTracker: string;
    whatIsIt: string;
    whatChanges: string[];
    faq: FaqItem[];
}

const gamePages: GamePage[] = [
    {
        path: 'fortnite/next-season/index.html',
        game: 'fortnite',
        type: 'next-season',
        typeTitle: 'Season End',
        title: 'Fortnite',
        kicker: 'Battle Royale',
        metaDescription: 'Track the exact countdown to when the current Fortnite season ends and the next one begins. Updated automatically from official Epic Games sources.',
        aboutTracker: 'This page tracks the official end date for the current Fortnite Battle Pass season. The countdown is sourced directly from the official Fortnite Battle Pass page on fortnite.com, so you always see the real date — not a community guess.',
        whatIsIt: 'Every few months, Epic Games launches a new Fortnite season with a completely refreshed Battle Pass, new map changes, fresh weapons, and unique gameplay mechanics. Each season typically lasts 10-13 weeks and introduces a new theme that reshapes the entire game experience. Knowing when the current season ends helps you plan your remaining Battle Pass challenges and prepare for whatever comes next.',
        whatChanges: [
            'New Battle Pass with 100+ tiers of cosmetics',
            'Map changes — new POIs, terrain updates, and biome shifts',
            'Fresh weapon and item loot pool',
            'New gameplay mechanics and vehicles',
            'Seasonal quests and XP challenges reset',
            'Competitive ranked season may reset'
        ],
        faq: [
            { q: 'When does the current Fortnite season end?', a: 'The exact end date is shown in the countdown above. This date is pulled directly from the official Fortnite Battle Pass page and updates automatically.' },
            { q: 'What happens when a Fortnite season ends?', a: 'When a season ends, your Battle Pass progress resets, the map typically changes, and a new set of weapons and items are introduced. Any unearned Battle Pass rewards from the previous season become unavailable.' },
            { q: 'Can Fortnite seasons be extended?', a: 'Yes, Epic Games occasionally extends seasons beyond their originally announced end date. Our tracker updates automatically when this happens, so the countdown always reflects the latest official date.' }
        ]
    },
    {
        path: 'lol/next-patch/index.html',
        game: 'lol',
        type: 'next-patch',
        typeTitle: 'Next Patch',
        title: 'League of Legends',
        kicker: 'MOBA',
        metaDescription: 'Track the next League of Legends patch release date. Live countdown sourced from Riot Games official patch schedule.',
        aboutTracker: 'This page tracks the next scheduled League of Legends patch release date. The data comes directly from Riot Games\' official patch schedule page, ensuring accuracy down to the exact day.',
        whatIsIt: 'League of Legends follows a consistent two-week patch cycle throughout the year. Each patch brings balance changes to champions, items, and runes, along with occasional new features, visual updates, and gameplay adjustments. Riot Games publishes their patch schedule at the start of each season, making LoL one of the most predictable games to track.',
        whatChanges: [
            'Champion balance adjustments (buffs, nerfs, reworks)',
            'Item stat changes and new item additions',
            'Rune and summoner spell modifications',
            'Bug fixes and quality-of-life improvements',
            'New skins and cosmetic content releases',
            'Ranked split transitions and seasonal events'
        ],
        faq: [
            { q: 'How often does League of Legends get patched?', a: 'LoL follows a strict two-week patch cycle. Riot Games publishes the full year\'s patch schedule in advance, so you always know when the next update is coming.' },
            { q: 'What time do LoL patches go live?', a: 'Patches typically deploy during early morning hours in each region. NA patches usually go live around 3:00 AM PT, while EUW patches deploy around 5:00 AM GMT.' },
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
        metaDescription: 'Track the latest VALORANT patch and game update. Live status sourced from official Riot Games patch notes.',
        aboutTracker: 'This page shows when the most recent VALORANT patch was released. The date is sourced from the official VALORANT game updates page on playvalorant.com.',
        whatIsIt: 'VALORANT receives regular patches from Riot Games that adjust agent abilities, weapon balance, and map rotations. Like League of Legends, VALORANT follows a roughly two-week patch cycle with alternating major and minor updates. Major patches introduce significant gameplay changes, while minor patches focus on bug fixes and smaller balance tweaks.',
        whatChanges: [
            'Agent ability balance changes and reworks',
            'Weapon damage, spread, and price adjustments',
            'Map rotation updates and new map releases',
            'Competitive ranking system changes',
            'Anti-cheat improvements and bug fixes',
            'New Battle Pass and cosmetic bundles'
        ],
        faq: [
            { q: 'How often does VALORANT get updated?', a: 'VALORANT follows a two-week patch cycle with alternating major and minor patches. Major patches bring bigger gameplay changes while minor patches focus on fixes.' },
            { q: 'When did the last VALORANT patch come out?', a: 'The exact date of the most recent patch is shown above. This updates automatically whenever Riot releases a new game update.' },
            { q: 'Does VALORANT have downtime during patches?', a: 'Yes, VALORANT typically goes offline for a few hours during patch deployment. Riot usually announces the maintenance window in advance on their social media channels.' }
        ]
    },
    {
        path: 'cs2/last-update/index.html',
        game: 'cs2',
        type: 'last-update',
        typeTitle: 'Last Update',
        title: 'Counter-Strike 2',
        kicker: 'Tactical Shooter',
        metaDescription: 'Track the latest Counter-Strike 2 update. Live status sourced from official Valve news and Steam RSS feeds.',
        aboutTracker: 'This page tracks the most recent Counter-Strike 2 update from Valve. Data is sourced from the official CS2 updates page and Steam news feed to ensure accuracy.',
        whatIsIt: 'Counter-Strike 2 receives periodic updates from Valve that can include everything from major gameplay changes to small balance tweaks. Unlike games with fixed patch schedules, CS2 updates arrive on Valve\'s own timeline — sometimes weekly, sometimes with longer gaps between releases. Each update is documented on the official Counter-Strike website with detailed release notes.',
        whatChanges: [
            'Weapon balance and economy adjustments',
            'Map updates, fixes, and visual improvements',
            'Anti-cheat (VAC) system improvements',
            'Sound, animation, and rendering fixes',
            'Competitive matchmaking and ranking changes',
            'New operation content and case releases'
        ],
        faq: [
            { q: 'How often does CS2 get updated?', a: 'CS2 doesn\'t follow a fixed schedule. Valve releases updates as needed — sometimes weekly for bug fixes, sometimes with longer gaps between major content updates.' },
            { q: 'When was the last CS2 update?', a: 'The date of the most recent update is shown in the tracker above. This data comes from Valve\'s official update announcements.' },
            { q: 'Do CS2 updates require a game restart?', a: 'Yes, updates are downloaded automatically through Steam and typically require restarting the game. Major updates may also require a brief matchmaking interruption.' }
        ]
    },
    {
        path: 'minecraft/last-release/index.html',
        game: 'minecraft',
        type: 'last-release',
        typeTitle: 'Last Release',
        title: 'Minecraft',
        kicker: 'Sandbox',
        metaDescription: 'Track the latest Minecraft Java Edition release. Live status sourced from official Minecraft feedback changelog.',
        aboutTracker: 'This page tracks the most recent Minecraft Java Edition release. The data is sourced from Mojang\'s official feedback changelog, which documents every version release with full patch notes.',
        whatIsIt: 'Minecraft follows a development cycle with major updates (e.g., 1.21, 1.22) and smaller point releases (e.g., 1.21.1, 1.21.2). Major updates introduce large new features like biomes, mobs, and gameplay mechanics, while point releases focus on bug fixes and stability improvements. Mojang typically releases one or two major updates per year, with snapshots and pre-releases available for testing beforehand.',
        whatChanges: [
            'New biomes, blocks, and world generation features',
            'New mobs and creature behavior updates',
            'Crafting recipes and item additions',
            'Redstone mechanics and technical changes',
            'Bug fixes and performance optimizations',
            'Experimental features from upcoming updates'
        ],
        faq: [
            { q: 'How often does Minecraft get updated?', a: 'Minecraft typically receives 1-2 major updates per year, with smaller bug-fix releases in between. Snapshots (test versions) are released more frequently for community testing.' },
            { q: 'When was the last Minecraft release?', a: 'The date of the most recent official release is shown above. This tracks stable releases, not snapshots or pre-releases.' },
            { q: 'Do I need to update manually?', a: 'If you\'re using the official Minecraft Launcher, updates are downloaded automatically. You can also choose to play older versions through the launcher\'s version selector.' }
        ]
    },
    {
        path: 'roblox/status/index.html',
        game: 'roblox',
        type: 'status',
        typeTitle: 'Status',
        title: 'Roblox',
        kicker: 'Platform',
        metaDescription: 'Check the current Roblox service status. Live monitoring sourced from official Roblox status API.',
        aboutTracker: 'This page monitors the current Roblox platform service status. Data comes directly from Roblox\'s official hosted status API, which reports real-time operational status across all Roblox services.',
        whatIsIt: 'Roblox is a platform hosting millions of user-created games and experiences. Service outages can affect millions of players worldwide, making status monitoring essential. This tracker checks the official Roblox status page to show you whether the platform is fully operational, experiencing degraded performance, or completely down.',
        whatChanges: [
            'Platform-wide service availability updates',
            'Game server connectivity status',
            'Website and app accessibility',
            'Roblox Studio functionality',
            'Marketplace and Robux transaction status',
            'Authentication and login service health'
        ],
        faq: [
            { q: 'Is Roblox down right now?', a: 'Check the status indicator above for real-time information. We pull data directly from Roblox\'s official status API every 6 hours.' },
            { q: 'What does "Operational" mean?', a: 'Operational means all Roblox services are running normally with no reported issues. If there\'s a problem, the status will change to reflect the type of disruption.' },
            { q: 'How long do Roblox outages usually last?', a: 'Most Roblox outages are resolved within a few hours. The platform has a strong track record of uptime, but periodic maintenance and rare incidents can cause temporary disruptions.' }
        ]
    },
    {
        path: 'gta/weekly-reset/index.html',
        game: 'gta',
        type: 'weekly-reset',
        typeTitle: 'Weekly Reset',
        title: 'GTA Online',
        kicker: 'Open World',
        metaDescription: 'Track the next GTA Online weekly reset countdown. Every Thursday at 10:00 UTC, Rockstar refreshes bonuses, discounts, and challenges.',
        aboutTracker: 'This page shows the exact countdown to the next GTA Online weekly content update. The reset time is computed from Rockstar Games\' established Thursday 10:00 UTC schedule, making this one of our highest-confidence trackers.',
        whatIsIt: 'Every Thursday at 10:00 UTC (6:00 AM Eastern), Rockstar Games refreshes GTA Online with new weekly content. This rotation has been a core part of GTA Online for years and gives players a reason to check in every week. The weekly reset brings new discounts, bonus payouts, and featured content that changes the best way to earn money and experience in the game.',
        whatChanges: [
            'New podium vehicle at the Diamond Casino',
            'Discounted properties, vehicles, and upgrades',
            'Double and triple GTA$ and RP on featured activities',
            'New time-limited weekly challenges',
            'Prize Ride challenge rotation',
            'Featured Adversary Mode and Survival maps'
        ],
        faq: [
            { q: 'What time does GTA Online reset each week?', a: 'GTA Online resets every Thursday at exactly 10:00 UTC (6:00 AM Eastern, 3:00 AM Pacific). The countdown above shows the exact time remaining until the next reset.' },
            { q: 'What changes during the GTA Online weekly reset?', a: 'Each week brings new discounted vehicles and properties, bonus payout activities (double/triple GTA$ and RP), a new podium vehicle, and refreshed weekly challenges.' },
            { q: 'Do I lose anything during the weekly reset?', a: 'No, your character progress, money, vehicles, and properties are never affected by the weekly reset. Only the featured content and discounts change.' }
        ]
    },
    {
        path: 'warzone/last-patch/index.html',
        game: 'warzone',
        type: 'last-patch',
        typeTitle: 'Last Patch',
        title: 'Warzone',
        kicker: 'Battle Royale',
        metaDescription: 'Track the latest Call of Duty Warzone patch. Live status sourced from official Activision patch notes.',
        aboutTracker: 'This page tracks the most recent Call of Duty Warzone patch release. Data is sourced from the official Call of Duty patch notes page at callofduty.com.',
        whatIsIt: 'Call of Duty: Warzone receives regular patches and updates from Activision and Raven Software that adjust weapon balance, fix bugs, and occasionally introduce new content. Warzone updates are typically synchronized with the broader Call of Duty ecosystem, meaning updates often affect both Warzone and the current mainline Call of Duty title simultaneously.',
        whatChanges: [
            'Weapon balance and attachment modifications',
            'Map changes, new POIs, and zone adjustments',
            'Anti-cheat (RICOCHET) system improvements',
            'Loadout and perk system changes',
            'Seasonal content and limited-time modes',
            'Performance optimizations and bug fixes'
        ],
        faq: [
            { q: 'How often does Warzone get updated?', a: 'Warzone typically receives updates every 1-2 weeks, with larger seasonal updates arriving roughly every 6 weeks. Mid-season updates often bring balance patches and new content.' },
            { q: 'When was the last Warzone patch?', a: 'The date of the most recent patch is shown above. This is sourced from the official Call of Duty patch notes page.' },
            { q: 'Are Warzone updates the same across all platforms?', a: 'Yes, Warzone patches release simultaneously across PlayStation, Xbox, and PC. All platforms receive the same balance changes and content updates.' }
        ]
    },
    {
        path: 'genshin/next-banner/index.html',
        game: 'genshin',
        type: 'next-banner',
        typeTitle: 'Next Banner End',
        title: 'Genshin Impact',
        kicker: 'Action RPG',
        metaDescription: 'Track the current Genshin Impact banner end date. Live countdown sourced from official HoYoverse announcements.',
        aboutTracker: 'This page tracks when the current Genshin Impact character event wish (banner) ends. Data is sourced from official HoYoverse/HoYoLAB announcements, so you know exactly how much time you have left to pull for featured characters.',
        whatIsIt: 'Genshin Impact uses a gacha system where limited-time character and weapon banners rotate every few weeks. Each banner features specific 5-star and 4-star characters that may not return for months. Knowing when a banner ends is critical for players deciding whether to spend their Primogems now or save for an upcoming character they want more.',
        whatChanges: [
            'Featured 5-star character rotation',
            'Featured 4-star character selections',
            'Weapon banner lineup changes',
            'Pity counter implications for banner changes',
            'Event wish duration and phase transitions',
            'Accompanying in-game events and activities'
        ],
        faq: [
            { q: 'When does the current Genshin banner end?', a: 'The exact end date is shown in the countdown above. Each version typically has two banner phases, each lasting about 3 weeks.' },
            { q: 'Does my pity reset when the banner changes?', a: 'Pity carries over between banners of the same type (character event wish). If you\'re at 70 pulls on one character banner, you\'ll still be at 70 when the next character banner starts.' },
            { q: 'How do I know which characters are coming next?', a: 'HoYoverse typically announces upcoming banners through the official Genshin Impact social media channels and in-game notices a few days before the current banner ends.' }
        ]
    },
    {
        path: 'pubg/last-patch/index.html',
        game: 'pubg',
        type: 'last-patch',
        typeTitle: 'Last Patch',
        title: 'PUBG',
        kicker: 'Battle Royale',
        metaDescription: 'Track the latest PUBG patch and update. Live status sourced from official PUBG patch notes.',
        aboutTracker: 'This page tracks the most recent PUBG: Battlegrounds patch. Data is sourced from the official PUBG patch notes page, with browser-based extraction to handle their dynamic content loading.',
        whatIsIt: 'PUBG: Battlegrounds receives regular updates from KRAFTON that introduce balance changes, new content, and gameplay improvements. PUBG follows a seasonal update model with major patches at the start of each season and smaller fix patches throughout. Each major update can bring new weapons, vehicles, map changes, and quality-of-life improvements to the battle royale experience.',
        whatChanges: [
            'New weapons, attachments, and vehicles',
            'Map updates and rotation changes',
            'Weapon balance and damage adjustments',
            'Ranked season transitions and reward resets',
            'Anti-cheat improvements and reporting tools',
            'New survivor pass and cosmetic content'
        ],
        faq: [
            { q: 'How often does PUBG get patched?', a: 'PUBG typically receives major updates at the start of each season (roughly every 2 months) with smaller fix patches in between as needed.' },
            { q: 'When was the last PUBG update?', a: 'The date of the most recent patch is displayed above. This is sourced from KRAFTON\'s official patch notes page.' },
            { q: 'Does PUBG have downtime during updates?', a: 'Yes, PUBG servers go offline for several hours during major patch deployments. KRAFTON usually announces maintenance schedules in advance through their official channels.' }
        ]
    },
    {
        path: 'red-dead-redemption-2/last-update/index.html',
        game: 'red-dead-redemption-2',
        type: 'last-update',
        typeTitle: 'Last Update',
        title: 'Red Dead Redemption 2',
        kicker: 'Open World',
        metaDescription: 'Track the latest Red Dead Redemption 2 and Red Dead Online update from Rockstar Games Newswire.',
        aboutTracker: 'This page tracks the most recent official Red Dead Redemption 2 news from Rockstar Games. Data is sourced from the Rockstar Newswire, which serves as the primary communication channel for all Rockstar game updates.',
        whatIsIt: 'Red Dead Redemption 2 and Red Dead Online receive periodic updates from Rockstar Games, though less frequently than GTA Online. Updates can include bug fixes, stability improvements, and occasional content additions for Red Dead Online. While Rockstar has shifted much of their focus to GTA, the Newswire still serves as the official source for any Red Dead-related announcements.',
        whatChanges: [
            'Red Dead Online content updates and events',
            'Bug fixes and stability improvements',
            'Platform-specific performance patches',
            'Seasonal and limited-time events',
            'Store and catalog rotations',
            'Anti-griefing and quality-of-life changes'
        ],
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
        metaDescription: 'Track the latest EA SPORTS FC title update and patch notes. Live status sourced from EA Forums Game Info Hub.',
        aboutTracker: 'This page tracks the most recent EA SPORTS FC title update. Data is sourced from the EA Forums Game Info Hub, where the development team posts official patch notes and update announcements.',
        whatIsIt: 'EA SPORTS FC (formerly FIFA) receives regular title updates throughout its annual cycle. These updates address gameplay balance, fix bugs, and occasionally introduce new features. Title updates are the primary way EA Sports tunes the game after launch, adjusting everything from player movement and shooting mechanics to goalkeeper AI and set-piece behavior.',
        whatChanges: [
            'Gameplay mechanic tuning (shooting, passing, dribbling)',
            'Goalkeeper and defender AI adjustments',
            'Ultimate Team card and chemistry changes',
            'Career mode fixes and improvements',
            'Set-piece and penalty system tweaks',
            'Online stability and matchmaking fixes'
        ],
        faq: [
            { q: 'How often does EA SPORTS FC get title updates?', a: 'Title updates typically arrive every few weeks, with more frequent updates early in the game\'s cycle (October-January) and less frequent updates later in the year.' },
            { q: 'When was the last EA FC update?', a: 'The date of the most recent title update is shown above. This is sourced from EA\'s official Game Info Hub on the EA Forums.' },
            { q: 'Do title updates affect Ultimate Team?', a: 'Yes, title updates can change gameplay mechanics that affect all modes including Ultimate Team. However, content updates (new promos, SBCs, objectives) happen separately through server-side updates.' }
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
  <meta name="description" content="${page.metaDescription}">
  <meta property="og:title" content="${page.title} ${page.typeTitle} - NextReset">
  <meta property="og:description" content="${page.metaDescription}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://nextreset.co/og.png">
  <link rel="canonical" href="https://nextreset.co/${page.game}/${page.type}/">
  <title>${page.title} ${page.typeTitle} - NextReset</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
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

  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YY6V5SR1DN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', 'G-YY6V5SR1DN');
  </script>

  ${faqSchema}
</head>
<body>
  <div class="container">
    <div class="game-page">
      <a href="/" class="back-link">← Back to Home</a>

      <!-- Game Header -->
      <div class="game-header">
        <h1 class="game-title" id="event-title">${page.title} ${page.typeTitle}</h1>
        <div class="game-meta">
          <span class="kicker">${page.kicker}</span>
        </div>
      </div>

      <!-- About -->
      <div class="content-section">
        <p>${page.aboutTracker}</p>
      </div>

      <!-- Countdown -->
      <div class="countdown-box" id="countdown">
        <div class="countdown-label">Checking official sources...</div>
        <div class="countdown-value countdown-skeleton">--:--:--</div>
      </div>

      <!-- Info Panel -->
      <div class="info-panel">
        <div class="info-row">
          <span class="info-label">Source</span>
          <span class="info-value" id="source">...</span>
        </div>
        <div class="info-row">
          <span class="info-label">Confidence</span>
          <span id="confidence" class="confidence">...</span>
        </div>
        <div class="info-row">
          <span class="info-label">Last Updated</span>
          <span class="info-value" id="last-updated">...</span>
        </div>
      </div>

      <!-- Notes -->
      <div id="notes" class="notes" style="display: none;"></div>

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

      <!-- Trust Box -->
      <div class="trust-box">
        <div class="trust-item">
          <div class="label">Data Source</div>
          <div class="value">Official Publisher</div>
        </div>
        <div class="trust-item">
          <div class="label">Update Frequency</div>
          <div class="value">Every 6 Hours</div>
        </div>
        <div class="trust-item">
          <div class="label">Method</div>
          <div class="value">Automated Monitoring</div>
        </div>
      </div>

    </div>

    <noscript>
      <div style="text-align: center; padding: 20px; color: #9ca3af; background: #111827; margin-top: 20px; border-radius: 12px;">
        JavaScript is required for live countdowns. Data shown below is from the latest check.
      </div>
    </noscript>

    <footer>
      <p>Data automatically updated every 6 hours from official sources.</p>
      <p>Not affiliated with any game publishers. All trademarks belong to their respective owners.</p>
      <p><a href="/about/">About</a> · <a href="/privacy/">Privacy Policy</a></p>
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

// Write all pages
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
