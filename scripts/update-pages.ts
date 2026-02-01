import * as fs from 'fs';
import * as path from 'path';

/**
 * Script to update all game pages with v1 refinements:
 * 1. Add OG image meta tag
 * 2. Clean up ad slot styling
 */

const gamePagesDir = path.join(__dirname, '../public');

const gamePages = [
    { path: 'fortnite/next-season/index.html', game: 'Fortnite', type: 'Next Season' },
    { path: 'lol/next-patch/index.html', game: 'League of Legends', type: 'Next Patch' },
    { path: 'valorant/last-patch/index.html', game: 'VALORANT', type: 'Last Patch' },
    { path: 'cs2/last-update/index.html', game: 'Counter-Strike 2', type: 'Last Update' },
    { path: 'minecraft/last-release/index.html', game: 'Minecraft', type: 'Last Release' },
    { path: 'roblox/status/index.html', game: 'Roblox', type: 'Service Status' },
    { path: 'gta/weekly-reset/index.html', game: 'GTA Online', type: 'Weekly Reset' },
    { path: 'warzone/last-patch/index.html', game: 'Warzone', type: 'Last Patch' },
    { path: 'genshin/next-banner/index.html', game: 'Genshin Impact', type: 'Next Banner' },
    { path: 'pubg/last-patch/index.html', game: 'PUBG', type: 'Last Patch' }
];

for (const page of gamePages) {
    const filePath = path.join(gamePagesDir, page.path);
    let content = fs.readFileSync(filePath, 'utf-8');

    // 1. Add OG image if not present
    if (!content.includes('og:image')) {
        content = content.replace(
            /<meta property="og:type" content="website">/,
            '<meta property="og:type" content="website">\n  <meta property="og:image" content="https://nextreset.co/og.png">'
        );
    }

    // 2. Update ad slots
    content = content.replace(
        /<div class="ad-slot" id="ad-top">Ad Space<\/div>/g,
        '<div class="ad-slot ad-slot--top"></div>'
    );

    content = content.replace(
        /<div class="ad-slot" id="ad-bottom">Ad Space<\/div>/g,
        '<div class="ad-slot ad-slot--bottom"></div>'
    );

    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✓ Updated ${page.game}`);
}

console.log('\n✅ All game pages updated!');
