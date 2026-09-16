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
│   └── robots.txt         # Crawl rules (sitemap.xml is generated into dist/)
├── scripts/
│   ├── providers/         # Game-specific data providers
│   ├── refresh-all.ts     # Orchestration script
│   └── types.ts           # TypeScript interfaces
├── package.json
└── tsconfig.json
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+ (the Gemini SDK requires it)
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

GTA Online, Roblox, League of Legends, Counter-Strike 2, Minecraft (Java Edition), PUBG, VALORANT, Warzone, Genshin Impact and EA SPORTS FC run on the V2 pipeline in `scripts/v2/`: an adapter produces events, they are
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
evaluation and uploads `build/ai-eval/report.md`. It never runs in routine production refreshes: it runs
once when a pull request that changes prompts, schemas, extraction, grounding or date logic, or the gold
set is opened, and on demand (for a model change, or after later fixes). Recorded fixture tests run in
normal CI.

### AI cost guardrails (V2)

AI is last-mile language understanding, not the crawler. The cheapest reliable path is tried first:

1. **Unchanged documents stop.** A 304 or an identical text hash ends the work with no model call.
2. **Structured and rule-based sources are deterministic.** JSON feeds (Roblox status) and recurring
   rules (GTA Online weekly reset) are parsed or computed by code and never sent to a model.
3. **Only changed, relevant prose goes to Gemini**, and only within the daily budget.

Every model call goes through one budget gate (`scripts/v2/cost/`). The limits are safety ceilings, not
targets, per UTC day:

| variable | default | meaning |
|---|---|---|
| `AI_DAILY_COST_LIMIT_USD` | `2.00` | estimated spend across all topics |
| `AI_DAILY_CALL_LIMIT` | `100` | model calls across all topics |
| `AI_PER_TOPIC_CALL_LIMIT` | `5` | model calls per topic |
| `AI_PRICE_INPUT_PER_M`, `AI_PRICE_OUTPUT_PER_M` | price table | override the list prices used for estimates; a model with no known price makes no calls |

- **Before a changed document is sent**, its worst case (classify, extract and one repair, each at its
  output cap and with every retry the provider may make) must fit what is left of today's budget. Each call
  is checked again right before it is made, against the UTC day it is made in. Repairs count against every
  limit.
- **When a limit is reached**, no call is made and nothing weaker is published: the work is marked
  `deferred_due_to_budget`, stored knowledge stays published (served as stale), the document is not
  marked as seen, and a later run retries it.
- **Usage is recorded per call** (provider, model, game, topic, operation, tokens, estimated input, output
  and total cost, success, retries, repair) in `knowledge/usage/ai/<date>.json` on the knowledge branch, so
  the limits hold across the day's runs. Prompts, documents, responses and keys are never recorded. When CI
  runs without the knowledge checkout, no model call is made that run.
- **Costs are estimates** from the price table in `scripts/v2/cost/pricing.ts`, not billing data.
- **Discovery runs at most once a day per topic** (`minIntervalHours` in the topic's discovery config), sooner
  only when a scheduled event has passed since the last search or evidence is held. Known sources are still
  re-checked on every 6-hourly refresh, which costs nothing when they are unchanged.

Each refresh writes an "AI usage and cost guardrails" table to the GitHub Actions step summary: calls, tokens
and estimated cost for the run and the day, remaining budget, and per tracker how many documents were skipped
unchanged, handled deterministically, sent to AI or deferred.

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

### Evidence-based trackers (V2)

League of Legends (`lol/next-patch`) is the first tracker on the full V2 path,
implemented by the generic adapter in `scripts/v2/adapters/ai-discovery.ts`:

1. **Known sources first.** The configured page (the V1 URL, which now redirects)
   and any page learned by earlier runs are fetched through the smart fetch
   layer; an unchanged page costs no model call.
2. **Discovery only when needed.** If no known page answers the open question
   (for example no future patch is scheduled any more), the discovery module
   searches the official channels, then the web, and tries the best official
   candidates.
3. **Understand and extract.** Gemini classifies the document and extracts the
   patch versions and dates; every fact must be quoted verbatim and passes the
   deterministic grounding checks. Non-official pages are never extracted from.
4. **Verify and publish.** Grounded facts become events (deterministic identity
   `lol/next-patch/26.19`), with the claims and the document persisted as
   evidence and the winning page learned as a source. The V1-compatible view
   publishes the discovered URL as `source_url` and a computed confidence.

Without `GEMINI_API_KEY`, or when the AI budget is exhausted, the tracker fails cleanly and serves stored
knowledge; the changed page is retried by a later run.
`npm run slice:lol` runs the slice end to end against the live network into a
throwaway store and prints the report; `--no-config-url` removes the configured
page so discovery has to find it. The "Vertical slice evaluation" workflow does
both in CI and uploads the results.

## 📰 Publishing

The pages are rendered from verified facts at build time, not assembled in the browser:

```
refresh:data  ->  export:site (public/ -> dist/)  ->  render:pages  ->  publish dist/
```

`render:pages` writes only into `dist/`, reads only `dist/data/*.json` and `knowledge/games/*.json`,
and calls nothing — no model, no search, no fetch. The authored pages under `public/` are untouched by
a build, so rolling any of this back is one line in `build:site`.

| Step | What it writes |
|------|----------------|
| `scripts/render-pages.ts` | each tracker page's value, state, source and verification times |
| `scripts/render-data-blocks.ts` | the blocks a game's knowledge supports: remaining schedule, verified history with a quote per row, regional end times |
| `scripts/render-home.ts` | every homepage card, grouped into what is next, what changed recently, and what nobody has answered |
| `scripts/render-sitemap.ts` | `sitemap.xml`, each page dated by when its own facts last changed |
| `scripts/version-assets.ts` | a content hash on every asset URL, since `_headers` caches them for a year |

`app.js` is progressive enhancement over the result: it may change the *form* of a value — a date
becomes a live countdown — and never its meaning. Tests assert that the two agree, because review
found the browser undoing the build in six different ways: replacing a rendered value when a refresh
failed, counting down to a midnight nobody announced, restoring a note the build had repaired.

Two rules the rendering follows everywhere:

- **A time is published only where the pipeline states the instant is exact.** A date-only value is
  shown as a date; the midnight it is stored at was never announced by anyone.
- **A future-facing value that has expired is not an answer.** The page keeps its question and says no
  official date has been published, rather than showing a date that has passed.

### Why there are no hub pages

Each of the twelve games answers exactly one question, so a `/<game>/` hub would contain a single link
and repeat the tracker page's title and value — a near-duplicate, which is worth less than nothing to a
reader or to an index. A hub per topic (`/next-patch/`) would be the homepage sliced differently, and
the homepage already groups by what the data says.

A full-history page was considered and rejected on the same ground: the store holds 19 CS2 updates and
24 League of Legends patches, and the tracker pages already publish every upcoming date and the twelve
most recent. A page whose only reason to exist is seven more rows of the same table is a thin page.

If a game ever gains a second question worth tracking, a hub becomes worth revisiting. Until then the
site is deliberately smaller than it could be.

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