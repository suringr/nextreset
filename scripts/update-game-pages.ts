import * as fs from 'fs';
import * as path from 'path';

/**
 * Update all game pages with new console hub design
 */

const publicDir = path.join(__dirname, '../public');

const gamePages = [
  { path: 'fortnite/next-season/index.html', game: 'fortnite', type: 'next-season', typeTitle: 'Season End', title: 'Fortnite', kicker: 'Pacific Break' },
  { path: 'lol/next-patch/index.html', game: 'lol', type: 'next-patch', typeTitle: 'Next Patch', title: 'League of Legends', kicker: 'MOBA' },
  { path: 'valorant/last-patch/index.html', game: 'valorant', type: 'last-patch', typeTitle: 'Last Patch', title: 'VALORANT', kicker: 'Tactical Shooter' },
  { path: 'cs2/last-update/index.html', game: 'cs2', type: 'last-update', typeTitle: 'Last Update', title: 'Counter-Strike 2', kicker: 'Tactical Shooter' },
  { path: 'minecraft/last-release/index.html', game: 'minecraft', type: 'last-release', typeTitle: 'Last Release', title: 'Minecraft', kicker: 'Sandbox' },
  { path: 'roblox/status/index.html', game: 'roblox', type: 'status', typeTitle: 'Status', title: 'Roblox', kicker: 'Platform' },
  { path: 'gta/weekly-reset/index.html', game: 'gta', type: 'weekly-reset', typeTitle: 'Weekly Reset', title: 'GTA Online', kicker: 'Open World' },
  { path: 'warzone/last-patch/index.html', game: 'warzone', type: 'last-patch', typeTitle: 'Last Patch', title: 'Warzone', kicker: 'Battle Royale' },
  { path: 'genshin/next-banner/index.html', game: 'genshin', type: 'next-banner', typeTitle: 'Next Banner', title: 'Genshin Impact', kicker: 'RPG' },
  { path: 'pubg/last-patch/index.html', game: 'pubg', type: 'last-patch', typeTitle: 'Last Patch', title: 'PUBG', kicker: 'Battle Royale' }
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
    @media(max-width:600px){.game-title{font-size:32px}.countdown-value{font-size:40px}}
  </style>

  <link rel="stylesheet" href="/assets/styles.v1.css">
  
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-YY6V5SR1DN"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', 'G-YY6V5SR1DN');
  </script>
</head>
<body>
  <div class="container">
    <div class="game-page">
      <a href="/" class="back-link">← Back to Home</a>
      
      <!-- Ad Top -->
      <div class="ad-slot ad-slot--top"></div>
      
      <!-- Game Header -->
      <div class="game-header">
        <h1 class="game-title" id="event-title">__TITLE__ __TYPE_TITLE__</h1>
        <div class="game-meta">
          <span class="kicker">__KICKER__</span>
        </div>
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
      
      <!-- Ad Bottom -->
      <div class="ad-slot ad-slot--bottom"></div>
    </div>
    
    <noscript>
      <div style="text-align: center; padding: 20px; color: #9ca3af; background: #111827; margin-top: 20px; border-radius: 12px;">
        JavaScript is required for live countdowns. Data shown below is from the latest check.
      </div>
    </noscript>

    <footer>
      <p>Data automatically updated every 6 hours from official sources.</p>
    </footer>
  </div>
  
  <!-- Data attributes for JS -->
  <div id="countdown-container" data-game="__GAME__" data-type="__TYPE__" style="display: none;"></div>
  
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
</html>
`;

for (const page of gamePages) {
  const filePath = path.join(publicDir, page.path);

  let content = template
    .replace(/__TITLE__/g, page.title)
    .replace('__TYPE_TITLE__', page.typeTitle)
    .replace('__DESCRIPTION__', `Track ${page.title} events and updates`)
    .replace('__KICKER__', page.kicker)
    .replace('__GAME__', page.game)
    .replace('__TYPE__', page.type);

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`✓ Updated ${page.title}`);
}

console.log('\n✅ All game pages updated with console hub design!');
