# PurgeBot (formerly Discord Cleanup Bot)

## Status

**Version:** v1.1.0 published on GitHub, running on Unraid from GHCR image.

**Current mode:** `dryRun: true` — not deleting anything yet.

## Current State

- **GitHub:** https://github.com/prophetse7en/purgebot (public, all URLs lowercase)
- **Docker image:** `ghcr.io/prophetse7en/purgebot:latest` (GHCR, public), tagged v1.1.0
- **Icon URL:** `https://raw.githubusercontent.com/prophetse7en/purgebot/main/icon.png`
- **GitHub Actions:** auto-builds multi-platform images (amd64+arm64) on push to main
- **SSH key:** `~/.ssh/id_ed25519_github` configured for GitHub pushes from Unraid
- Running on Unraid (proxynet, unless-stopped) from GHCR image
- Unraid template: `/boot/config/plugins/dockerMan/templates-user/my-purgebot.xml`
- Public Unraid template in repo: `unraid-template.xml`
- Bot token + Guild ID configured, bot online

## Features

### Web UI (port 3050, 7 tabs)

1. **Overview** — Category Manager with Enable All/Disable All/Set Retention + per-channel Run/Dry Run and inline results
2. **Cleanup** — Unified dry-run/live toggle with stop support
3. **Sync** — Channel discovery with per-change detail display (+/- indicators)
4. **Statistics**
5. **Configuration** — Global settings + Discord webhooks + log retention (schedule moved to own tab)
6. **Schedule** — Description text + dry run warning when dryRun=true
7. **Logs** — Order reversed (newest first), stable DOM keys via logSeq counter

### Core Features

- Mass edit retention: bulk-apply default retention days across selected categories
- Global stop button in header (visible from any tab when cleanup is running)
- Timezone consolidated to TZ env var only (removed from config.yaml)
- Per-channel progress logging every 10 messages during slow >14d deletes
- Cron log dedup (tracks previous schedule, logs "rescheduled" on change)
- Cleanup summary: collapsible with timestamp, trigger badges, clickable Run History
- Live cleanup progress: results build incrementally per channel via SSE (cleanup-progress events)
- SSE-based real-time updates (no polling timeouts), safeSend guard on all SSE writes
- Rate limiting (60 req/min per IP) on state-changing endpoints
- Branded footer "PurgeBot vX.Y.Z by ProphetSe7en" on all Discord embeds (cleanup, discovery, webhook test)

### Safety

- Safety audit passed: all 7 deletion safety guarantees verified
- Full code review: 1 critical + 11 medium fixed, verification review clean

## Last Worked On

**2026-03-07b:**
- Branded footer "PurgeBot vX.Y.Z by ProphetSe7en" on all Discord embeds (cleanup, discovery, webhook test)
- Schedule tab: description text + dry run warning when dryRun=true
- Pushed to GitHub (`e65a452`), GHCR build triggered

## GitHub Workflow

### Push Procedure

Clone -> rsync files (exclude .git, node_modules, config.yaml, .env, logs/, stats.json, icon[0-9]*.png, "App icon*") -> commit -> push -> delete temp dir.

- SSH via `git@github.com:ProphetSe7en/purgebot.git`
- Git config: name=ProphetSe7en, email=ProphetSe7en@users.noreply.github.com

### GHCR Build

- GitHub Actions auto-builds multi-platform images (amd64+arm64) on push to main
- Image: `ghcr.io/prophetse7en/purgebot:latest` (public)
- Version tagged: v1.1.0

## Next Steps

1. **Test webhooks tab + settings layout** on live Unraid
2. **Test fresh install flow** — Delete config, sync, dry-run, live run
3. **Set up `webhooks.info` Discord channel** for discovery notifications
4. **Set `dryRun: false`** when satisfied

## Reference Docs

- `containers/purgebot/README.md`
- `docs/ideas/discord_cleanup_bot.md` (original design ideas)
