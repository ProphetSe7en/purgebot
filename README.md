# PurgeBot

Automated message cleanup for Discord servers. Define retention policies per category and channel, and let PurgeBot handle the rest — on a schedule or on-demand via the built-in Web UI.

Built for servers with many channels (media automation, homelab, development) where messages pile up across dozens of categories and manual cleanup is impractical.

## Features

- **Hierarchical retention** — channel override > category default > global default
- **Web UI** — manage categories, edit retention, trigger runs, view logs — all from a browser
- **Auto-discovery** — new channels and categories are detected automatically before each run
- **Allow-list safety** — only channels explicitly listed in config are processed
- **Dry-run mode** — see what would be deleted before enabling live cleanup
- **Per-channel and per-category runs** — test or clean individual channels from the UI
- **Inline results** — run results appear directly in the UI (no log-hunting)
- **Live log streaming** — SSE-based real-time log viewer with level filtering
- **Scheduled cleanup** — cron-based scheduling with timezone support
- **Hot-reload config** — edit config.yaml or use the Web UI — changes take effect on next run
- **Webhook notifications** — cleanup summaries and auto-discovery alerts to Discord
- **>14-day delete support** — individually deletes messages older than Discord's bulk-delete limit
- **Atomic config writes** — write-to-temp then rename prevents corruption
- **Docker-native** — PUID/PGID/UMASK, healthcheck, Alpine-based (~45 MB)

## Quick Start

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name (e.g. "PurgeBot"), and create it
3. Go to the **Bot** tab:
   - Click **Reset Token** and copy the token — you'll need this as `DISCORD_TOKEN`
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Go to **OAuth2 > URL Generator**:
   - **Scopes:** select `bot`
   - **Bot Permissions:** select `Administrator` (simplest — needed for private channels), or at minimum: `View Channels`, `Read Message History`, `Manage Messages`
5. Copy the generated URL, open it in your browser, select your server, and authorize

> **Finding your Guild ID:** Enable Developer Mode in Discord (Settings > Advanced > Developer Mode), then right-click your server name and click "Copy Server ID". This is your `GUILD_ID`.

### 2. Run with Docker

```bash
docker run -d \
  --name purgebot \
  --restart unless-stopped \
  -p 3050:3050 \
  -e DISCORD_TOKEN=your_bot_token \
  -e GUILD_ID=your_server_id \
  -v /path/to/config:/config \
  ghcr.io/ProphetSe7en/purgebot:latest
```

On first run, a default `config.yaml` is created in the config volume. Open the Web UI at `http://your-host:3050` to configure everything.

### 3. Initial Setup

1. Open `http://your-host:3050` — the Web UI is available immediately
2. Wait for the bot to connect to Discord (green "Connected" badge in the header)
3. Click **Sync Channels** in the Overview tab — this discovers all your categories and channels
4. Enable the categories you want cleaned and set retention periods
5. Run a **Dry Run** to preview what would be deleted
6. When satisfied, set `dryRun: false` in the Configuration tab

## Web UI

The built-in Web UI runs on port 3050 (same container, no separate service).

### Overview Tab

Dashboard with stat cards (categories, last run, errors, next cleanup) and a full **Category Manager**:

- Click the Categories card to expand the management panel
- Each category is collapsible with enable/disable toggle, default retention editor, and channel list
- Per-channel retention overrides with inline editing
- **Run Now / Dry Run** buttons on both category and individual channel level
- Results appear inline (channels scanned, messages deleted, per-channel breakdown)

### Configuration Tab

Global settings: schedule, timezone, global default retention, dry-run toggle, skip pinned, rate limits.

### Schedule Tab

Edit the cron expression directly with a human-readable preview. Changes apply immediately (no restart needed).

### Logs Tab

Real-time log streaming via Server-Sent Events. Filter by level (INFO/WARN/ERROR), search text, or browse historical log files by date.

### Test Tab

Run a dry-run test for all categories or a specific one. Results show per-category breakdown with per-channel message counts.

## Configuration

Configuration lives in `/config/config.yaml` (inside the Docker volume). You can edit it manually or use the Web UI — the bot re-reads config before each cleanup run.

### Retention Hierarchy

Retention is resolved per-channel using the first match:

1. **Inline override** on the channel entry (e.g., `- noisy-channel: 3`)
2. **Category default** (e.g., `default: 7`)
3. **Global default** (`globalDefault: 7`)

### Retention Values

| Value | Meaning |
|-------|---------|
| `-1` | Never delete (keep forever) |
| `0` | Delete all messages |
| `N` | Keep messages newer than N days, delete older |

### Example Config

```yaml
schedule: "0 2 * * *"    # Daily at 02:00
timezone: "America/New_York"
globalDefault: 7          # 7-day fallback
dryRun: true              # Start with true, set false when ready

webhooks:
  cleanup: "https://discord.com/api/webhooks/..."   # Cleanup summaries
  info: "https://discord.com/api/webhooks/..."      # Auto-discovery alerts

discord:
  maxMessagesPerChannel: 500
  maxOldDeletesPerChannel: 50    # Cap for >14-day individual deletes
  delayBetweenChannels: 2000     # Rate limit protection (ms)
  skipPinned: true

logging:
  maxDays: 30

categories:
  Radarr:
    enabled: true
    default: 7
    _channels:
      - grab                     # Uses category default (7 days)
      - imported                 # Uses category default (7 days)
      - upgrade: 3              # Override: 3 days
      - corruption: -1          # Override: never delete
  Sonarr:
    enabled: true
    default: 14
    _channels:
      - grab
      - imported
  NewCategory:
    enabled: false              # Discovered but not yet activated
    default: 7
    _channels:
      - some-channel
```

### Inline Overrides

Channels in `_channels` can be plain strings (inherit category/global default) or key-value pairs for per-channel overrides:

```yaml
_channels:
  - general              # plain string -> uses default
  - noisy-channel: 3     # override -> 3 days
  - archive: -1          # override -> never delete
```

### Webhook Notifications (Optional)

PurgeBot can send cleanup summaries and auto-discovery alerts to Discord via webhooks:

1. In Discord, right-click a channel > **Edit Channel** > **Integrations** > **Webhooks** > **New Webhook**
2. Copy the webhook URL
3. Add it to config:
   - `webhooks.cleanup` — receives an embed per category after each cleanup run (shows channels processed and messages deleted)
   - `webhooks.info` — receives notifications when new categories or channels are discovered on your server

You can use the same webhook URL for both, or separate channels for different notification types.

## Auto-Discovery

Before each scheduled cleanup, PurgeBot scans Discord for new categories and channels:

- **New categories** are added as `enabled: false` with the global default retention
- **New channels** in existing categories are added to `_channels` (inheriting the category default)
- Discovery notifications are sent to the `webhooks.info` webhook (after the first run)
- Config is written atomically only when changes are detected

Use **Sync Channels** in the Web UI or run `--sync` from the CLI for a full reconciliation that also removes categories/channels no longer on Discord.

## Docker

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Bot token from Discord Developer Portal |
| `GUILD_ID` | Yes | — | Discord server (guild) ID |
| `TZ` | No | `UTC` | Container timezone |
| `PUID` | No | `99` | User ID for file ownership |
| `PGID` | No | `100` | Group ID for file ownership |
| `UMASK` | No | `002` | File creation mask |

### Volumes

| Container Path | Purpose |
|---------------|---------|
| `/config` | Config file, logs, and stats persistence |

### Ports

| Port | Purpose |
|------|---------|
| `3050` | Web UI |

### Docker Compose

```yaml
services:
  purgebot:
    image: ghcr.io/ProphetSe7en/purgebot:latest
    container_name: purgebot
    restart: unless-stopped
    ports:
      - "3050:3050"
    environment:
      - DISCORD_TOKEN=your_bot_token
      - GUILD_ID=your_server_id
      - TZ=America/New_York
      - PUID=1000
      - PGID=1000
      - UMASK=002
    volumes:
      - ./purgebot-config:/config
```

### Building from Source

```bash
git clone https://github.com/ProphetSe7en/purgebot.git
cd purgebot
docker build -t purgebot .
docker run -d --name purgebot -p 3050:3050 \
  -e DISCORD_TOKEN=... -e GUILD_ID=... \
  -v ./config:/config purgebot
```

### Healthcheck

The container includes a built-in healthcheck that verifies the bot has run successfully within the last 28 hours. Docker (and platforms like Unraid/Portainer) will show the container as unhealthy if no cleanup has completed in that window.

### Unraid

PurgeBot includes an Unraid Docker template for easy installation:

1. In the Unraid web UI, go to **Docker > Add Container > Template Repositories**
2. Add: `https://github.com/ProphetSe7en/purgebot`
3. Click **Add Container**, select the PurgeBot template
4. Fill in `DISCORD_TOKEN` and `GUILD_ID`
5. Click **Apply**

The Web UI is available at `http://your-unraid-ip:3050`. Config is stored in `/mnt/user/appdata/purgebot` by default.

## CLI Commands

```bash
# Discover channels and sync config
docker exec purgebot node src/bot.js --sync

# Run cleanup immediately
docker exec purgebot node src/bot.js --now
```

These are useful for initial setup. For ongoing use, the Web UI provides the same functionality.

## API Reference

The Web UI communicates via a REST API. All state-changing requests require the `X-Requested-With: XMLHttpRequest` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Full config as JSON |
| `PUT` | `/api/config` | Replace full config |
| `PATCH` | `/api/config/global` | Update global settings |
| `PATCH` | `/api/config/category/:name` | Update single category |
| `GET` | `/api/stats` | Last run stats + history (30 runs) |
| `GET` | `/api/stats/status` | Live bot status (connected, running, next run) |
| `POST` | `/api/cleanup/run` | Trigger cleanup (`{category, channel}` optional) |
| `POST` | `/api/cleanup/sync` | Trigger channel sync (returns result) |
| `POST` | `/api/cleanup/dryrun` | Force dry-run (`{category, channel}` optional) |
| `GET` | `/api/logs?date=&level=&search=&limit=` | Read log files |
| `GET` | `/api/logs/stream` | SSE endpoint for live logs |

## Architecture

Single Node.js process — Express runs in the same process as the Discord bot, sharing the live config object and Discord client directly.

```
src/
├── bot.js                      # Bot core: config, cleanup logic, cron, Discord client
└── ui/
    ├── server.js               # Express setup, middleware, route mounting
    ├── public/
    │   └── index.html          # Single-page app (Alpine.js + Tailwind CSS)
    └── routes/
        ├── config.js           # Config CRUD with validation
        ├── control.js          # Run/sync/dryrun triggers
        ├── logs.js             # Log file reader + SSE streaming
        └── stats.js            # Stats from stats.json + live status
```

**Frontend:** Alpine.js + Tailwind CSS (bundled locally in Docker image for offline support). No build step.

**Key design decisions:**
- Express starts before Discord login (UI available immediately, API returns 503 if not connected)
- Config reference stability — clear+assign pattern keeps exported object reference valid across reloads
- Atomic writes — all config changes write to `.tmp` then rename
- SSE with EventEmitter bridge for real-time log streaming
- Stats persisted to `/config/stats.json` (last 30 runs)

## Security Notes

The Web UI has no authentication — anyone with network access to port 3050 can view config and trigger runs. This is standard for homelab tools (Sonarr, Radarr, etc.) but you should:

- Only expose port 3050 on your local network
- Use a reverse proxy with authentication if exposing externally
- The API config endpoint can expose webhook URLs — treat port 3050 as a trusted interface
- The Discord bot token is passed via environment variable and never exposed through the API

## License

MIT
