# Tesla Model X Dashboard

## Project Context
Bun/SQLite web app with 10 scrapers tracking used Tesla Model X inventory.
All scrapers filter year=2023-2026, mileage<=50000.

## Beads Integration
This project uses **beads** (`bd`) in stealth mode for structured task tracking.

### Session Start
1. Run `bd ready` to see available work
2. Run `bd list --status=open` for all open issues
3. Pick an issue and `bd update <id> --status=in_progress`

### During Work
- Create issues: `bd create --title="..." --type=task --priority=2`
- Track dependencies: `bd dep add <issue> <depends-on>`
- Priority scale: P0 (critical) → P4 (backlog). Use numbers, not "high"/"medium"/"low".
- NEVER edit files inside `.beads/` manually — always use the `bd` CLI

### Session End
- Close completed issues: `bd close <id1> <id2> ...`
- Flush state: `bd sync --flush-only`
- Then follow normal /handover procedure

## Architecture Notes
- **nodriver** (Python) bypasses Akamai Bot Manager where Playwright stealth fails
- Pattern: `Bun.spawn(["python", script])` → nodriver loads page → stdout markers → Bun parses
- SQLite bulk ops chunk at 500 (999 variable limit)
- VIN enrichment: Brave Search API → dealer domains → JSON-LD extraction (pLimit 3)
- Bun's TLS fingerprint triggers Cloudflare 403s on dealer sites — use curl subprocess instead
