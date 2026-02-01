import * as fs from 'fs';
import * as path from 'path';

/**
 * Update all game pages with new console hub design
 */

const publicDir = path.join(__dirname, '../public');

const gamePages = [
    { path: 'fortnite/next-season/index.html', game: 'fortnite', type: 'next-season', title: 'Fortnite', kicker: 'Battle Royale' },
    { path: 'lol/next-patch/index.html', game: 'lol', type: 'next-patch', title: 'League of Legends', kicker: 'MOBA' },
    { path: 'valorant/last-patch/index.html', game: 'valorant', type: 'last-patch', title: 'VALORANT', kicker: 'Tactical Shooter' },
    { path: 'minecraft/last-release/index.html', game: 'minecraft', type: 'last-release', title: 'Minecraft', kicker: 'Sandbox' },
    { path: 'roblox/status/index.html', game: 'roblox', type: 'status', title: 'Roblox', kicker: 'Platform' },
    { path: 'gta/weekly-reset/index.html', game: 'gta', type: 'weekly-reset', title: 'GTA Online', kicker: 'Open World' },
    { path: 'warzone/last-patch/index.html', game: 'warzone', type: 'last-patch', title: 'Warzone', kicker: 'Battle Royale' },
    { path: 'genshin/next-banner/index.html', game: 'genshin', type: 'next-banner', title: 'Genshin Impact', kicker: 'RPG' },
    { path: 'pubg/last-patch/index.html', game: 'pubg', type: 'last-patch', title: 'PUBG', kicker: 'Battle Royale' }
];

const template = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="__DESCRIPTION__">
  <meta property="og:title" content="__TITLE__ - NextReset">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://nextreset.co/og.png">
  <title>__TITLE__ - NextReset</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/favicon.png">
  <link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
  <div class="container">
    <div class="game-page">
      <a href="/" class="back-link">← Back to Home</a>
      
      <!-- Ad Top -->
      <div class="ad-slot ad-slot--top"></div>
      
      <!-- Game Header -->
      <div class="game-header">
        <h1 class="game-title" id="event-title">Loading...</h1>
        <div class="game-meta">
          <span class="kicker">__KICKER__</span>
        </div>
      </div>
      
      <!-- Countdown -->
      <div class="countdown-box" id="countdown">
        <div class="countdown-label">Loading data...</div>
        <div class="countdown-value">--</div>
      </div>
      
      <!-- Info Panel -->
      <div class="info-panel">
        <div class="info-row">
          <span class="info-label">Source</span>
          <span class="info-value" id="source">Loading...</span>
        </div>
        <div class="info-row">
          <span class="info-label">Confidence</span>
          <span id="confidence" class="confidence">Loading...</span>
        </div>
        <div class="info-row">
          <span class="info-label">Last Updated</span>
          <span class="info-value" id="last-updated">...</span>
        </div>
      </div>
      
      <!-- Notes -->
      <div id="notes" class="notes" style="display: none;"></div>
      
      <!-- Ad Bottom -->
      <div class="ad-slot ad-slot--bottom"></div>
    </div>
    
    <footer>
      <p>Data automatically updated every 6 hours from official sources.</p>
    </footer>
  </div>
  
  <!-- Data attributes for JS -->
  <div id="countdown-container" data-game="__GAME__" data-type="__TYPE__" style="display: none;"></div>
  
  <script src="/assets/app.js"></script>
</body>
</html>
`;

for (const page of gamePages) {
    const filePath = path.join(publicDir, page.path);

    let content = template
        .replace(/__TITLE__/g, page.title)
        .replace('__DESCRIPTION__', `Track ${page.title} events and updates`)
        .replace('__KICKER__', page.kicker)
        .replace('__GAME__', page.game)
        .replace('__TYPE__', page.type);

    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✓ Updated ${page.title}`);
}

console.log('\n✅ All game pages updated with console hub design!');
