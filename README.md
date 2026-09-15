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

# Install the headless browser used by some providers (one-time)
npx playwright install chromium

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

### Tests

```bash
npm run build && npm test
```

## 🧠 Knowledge store (V2 pilot)

GTA Online and Roblox run on the V2 pipeline in `scripts/v2/`: an adapter produces events, they are
stored in a per-game JSON knowledge file (`knowledge/games/<game>.json`, schema in `scripts/v2/domain.ts`),
and the V1-compatible `/data/<game>.<type>.json` is derived from that knowledge. Every other tracker
still runs its V1 provider; `REGISTRY` in `scripts/refresh-all.ts` shows which engine each one uses.

In CI, `knowledge/` is a git worktree of the `knowledge` branch: checked out before the refresh and
pushed back afterwards (`.github/scripts/knowledge-*.sh`). Locally the directory is created on demand
and is gitignored.

### AI-assisted extraction (V2)

`scripts/v2/ai/` holds the language-model layer behind a small `AiProvider` interface. The production
provider is Google Gemini (`@google/genai`); a mock provider serves tests and offline evaluation.
Every date the model reports must come with a verbatim quote, and deterministic code verifies the quote
occurs in the document and names the claimed day/month before anything is accepted. The model never
assigns confidence, never decides what is published, and never sees URLs it could echo as evidence.

Configuration is environment only (never committed):

| variable | meaning |
|---|---|
| `AI_PROVIDER` | `gemini` (default) or `mock` |
| `AI_MODEL` | model id, default `gemini-3.5-flash` |
| `GEMINI_API_KEY` | API key; in CI the `GEMINI_API_KEY` repository secret |

Gold evaluation over real publisher documents: `npm run ai:eval` (scripted mock responses, offline) or
`npm run ai:eval:live` (needs the key). The "AI extraction gold evaluation" workflow runs the live
evaluation on demand and uploads `build/ai-eval/report.md`.

### Web discovery (V2)

When a topic has no known source, or its known sources stop answering the open
question (for example no future patch is scheduled any more), the V2 pipeline can
find the right page instead of relying on a preconfigured URL. Code lives in
`scripts/v2/discovery`.

- **Query templates** are deterministic: the topic configures phrases such as
  `{game} patch schedule` and `{game} patch {next}`, where `{next}` is derived
  from the latest known version.
- **Official channels first.** Each game declares its official domains; their
  XML sitemaps and configured seed pages (listings, hubs) are searched without any
  API key. Only when they find nothing convincing is the web asked.
- **Web search** goes through a `SearchProvider` (DuckDuckGo's HTML endpoint by
  default, no key). It is best effort: a bot challenge disables it for the run and
  the pipeline continues with the official channels. Queries are capped and spaced
  (`SEARCH_PROVIDER=duckduckgo|none`, `SEARCH_MAX_QUERIES`, `SEARCH_MIN_INTERVAL_MS`).
- **Tiering.** A candidate is *official* only if its host is one of the game's
  official domains (or a subdomain). Secondary pages (forums, news, videos) can
  lead to an official link, but are never publishable evidence and are never
  learned as sources.
- **Ranking** is deterministic (official first, then query-term overlap, preferred
  phrases, and how the page was found). Gemini is asked to judge relevance from
  URLs, titles and snippets only when the top official candidates are too close
  to call; its verdict nudges the order and can never change a page's tier.
- **Learning.** A page that produced accepted knowledge is stored in the game's
  knowledge file (`discovered`) and consulted before searching on later runs.

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