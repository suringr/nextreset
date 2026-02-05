import * as fs from 'fs';
import * as path from 'path';

/**
 * Add favicon tags to all HTML pages
 */

const publicDir = path.join(__dirname, '../public');

// Favicon HTML to add
const faviconTags = `  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#0b0f14">`;

// Update homepage
const indexPath = path.join(publicDir, 'index.html');
let indexContent = fs.readFileSync(indexPath, 'utf-8');
if (!indexContent.includes('favicon.png')) {
    indexContent = indexContent.replace(
        '<link rel="stylesheet" href="/assets/styles.css">',
        `${faviconTags}\n  <link rel="stylesheet" href="/assets/styles.css">`
    );
    fs.writeFileSync(indexPath, indexContent, 'utf-8');
    console.log('✓ Updated homepage');
}

// Update all game pages
const gamePages = [
    'fortnite/next-season/index.html',
    'lol/next-patch/index.html',
    'valorant/last-patch/index.html',
    'cs2/last-update/index.html',
    'minecraft/last-release/index.html',
    'roblox/status/index.html',
    'gta/weekly-reset/index.html',
    'warzone/last-patch/index.html',
    'genshin/next-banner/index.html',
    'pubg/last-patch/index.html'
];

for (const pagePath of gamePages) {
    const filePath = path.join(publicDir, pagePath);
    let content = fs.readFileSync(filePath, 'utf-8');

    if (!content.includes('favicon.png')) {
        content = content.replace(
            '<link rel="stylesheet" href="/assets/styles.css">',
            `${faviconTags}\n    <link rel="stylesheet" href="/assets/styles.css">`
        );
        fs.writeFileSync(filePath, content, 'utf-8');
        const gameName = pagePath.split('/')[0];
        console.log(`✓ Updated ${gameName}`);
    }
}

console.log('\n✅ All pages updated with favicon!');
