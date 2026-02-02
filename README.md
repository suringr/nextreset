# NextReset

🌐 **Live Site: [nextreset.co](https://nextreset.co)**

**Automated game countdown and status tracking website**

NextReset is a fully automated static website that displays countdowns or status pages for popular games. After initial setup, the system requires **zero manual maintenance**.

## 🎯 Features

- **10 Game Providers**: Fortnite, League of Legends, VALORANT, Counter-Strike 2, Minecraft, Roblox, GTA Online, Warzone, Genshin Impact, and PUBG
- **Automated Data Refresh**: GitHub Actions runs every 6 hours to fetch latest data
- **Fail-Safe Design**: Provider failures don't break the site - old data is preserved
- **Official Sources Only**: All data comes from official game publishers
- **Static & Fast**: No backend, served via Cloudflare Pages

## 📁 Project Structure

```
nextreset/
├── .github/workflows/     # GitHub Actions automation
├── public/
│   ├── data/              # Generated JSON files (auto-updated)
│   ├── robots.txt         # SEO configuration
│   └── sitemap.xml        # Search engine sitemap
├── scripts/
│   ├── providers/         # Game-specific data providers
│   ├── refresh-all.ts     # Orchestration script
│   └── types.ts           # TypeScript interfaces
├── package.json
└── tsconfig.json
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run data refresh
npm run refresh:data
```

## 🔧 Development

```bash
# Watch mode for TypeScript
npm run dev
```

## 🎮 How It Works

### Provider Pattern

Each game is implemented as a **provider module** that:

1. Fetches data from official sources
2. Parses/extracts relevant dates
3. Returns normalized JSON data
4. Handles errors gracefully

All providers follow the `ProviderResult` interface:

```typescript
interface ProviderResult {
  game: string;              // e.g., "fortnite", "gta"
  type: string;              // e.g., "next-season", "weekly-reset"
  title: string;             // Human-readable title
  nextEventUtc: string;      // ISO 8601 UTC timestamp
  lastUpdatedUtc: string;    // ISO 8601 UTC timestamp
  source: { name, url };     // Attribution
  confidence: "high" | "medium" | "low";
  notes?: string;
}
```

### Orchestration

The `refresh-all.ts` script:

- Runs all providers sequentially (avoids rate limiting)
- Writes JSON to `public/data/<game>.<type>.json`
- **Fail-safe**: If a provider fails but old JSON exists, keeps the old data
- **Fail-fast**: Exits with error if any provider has no data (missing JSON)

### Automation

GitHub Actions workflow (`.github/workflows/refresh-data.yml`):

- **Triggers**: Every 6 hours via cron + manual dispatch
- **Steps**: Install deps → Build → Refresh data → Commit changes
- **Permissions**: `contents: write` to auto-commit

### Data Sources

| Game | Source | Type | Confidence |
|------|--------|------|-----------|
| Fortnite | Epic Games Help Center | HTML scrape | Medium |
| League of Legends | Riot Patch Schedule | HTML scrape | High |
| VALORANT | Official Patch Notes | HTML scrape | Medium |
| Counter-Strike 2 | Steam Store RSS | RSS/XML | High |
| Minecraft | Feedback Changelog | HTML scrape | High |
| Roblox | Hostedstatus JSON API | JSON API | High |
| GTA Online | Computed (Thu 10:00 UTC) | Computed | High |
| Warzone | CoD Patch Notes | HTML scrape | Medium |
| Genshin Impact | HoYoLAB Notices | HTML scrape | Medium |
| PUBG | Official Patch Notes | HTML scrape | Medium |

## 🌐 Deployment

### Cloudflare Pages

1. Connect GitHub repository to Cloudflare Pages
2. **Build command**: (none - already built by GitHub Actions)
3. **Output directory**: `public`
4. Deploy!

The site will automatically update as GitHub Actions commits new JSON files.

### URL Structure

Each page follows: `https://nextreset.co/<game>/<event>`

Examples:
- `/fortnite/next-season`
- `/lol/next-patch`
- `/gta/weekly-reset`
- `/cs2/last-update`

## 🛠 Adding a New Provider

1. Create `scripts/providers/<game>.ts`
2. Implement `export async function run(): Promise<ProviderResult>`
3. Add to `scripts/refresh-all.ts` imports and providers array
4. Test locally: `npm run build && npm run refresh:data`

### Provider Requirements

- **Use official sources only**
- **Robust text-based extraction** (avoid fragile CSS selectors)
- **Normalize all timestamps to UTC**
- **Throw on parse failure** (orchestration handles errors)
- **Include fetch hardening**:
  - Custom User-Agent: `NextReset/1.0 (+https://nextreset.co)`
  - Timeout: 15 seconds
  - Accept-Language: `en-US`

## 📊 Exit Policy

The orchestration script follows these rules:

- **Exit 1**: If any provider is missing JSON (no fallback data) → Fails the workflow
- **Exit 0**: If at least one provider succeeded → Success

This ensures:
- Workflow fails loudly on initial setup (missing data)
- Tolerates transient failures in production (old data preserved)

## 🔍 SEO

- `robots.txt`: Allows HTML pages, disallows `/data/` directory
- `sitemap.xml`: Lists all game event pages for search engines

## 📝 License

MIT

## 🤝 Contributing

This is a zero-maintenance automation project. Contributions welcome for:
- New game providers
- Improved data extraction
- Bug fixes for existing providers