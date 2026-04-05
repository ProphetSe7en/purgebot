# Changelog

## v1.2.0

### Features
- **Gotify push notifications** — Configurable Gotify support for cleanup summaries and auto-discovery notifications. Per-level priority toggles (Warning/Info) with customizable priority values. Gotify receives a combined summary with per-category breakdown instead of individual per-category messages.
- **Gotify settings UI** — Collapsible Gotify section in Settings with enable toggle, URL/token fields, test button, and priority configuration.
- **Configurable delete delay** — New `delayBetweenDeletes` setting (default 400ms, min 200ms) controls pause between individual old message deletes (>14 days).
- **Auto-cleanup of deleted channels** — Channels and categories deleted from Discord are automatically removed from config during discovery, with notifications showing what was removed and which category it belonged to.

### Improvements
- **Faster cleanup runs** — `delayBetweenChannels` default reduced from 2000ms to 500ms. Delay is now skipped entirely when a channel had nothing to delete. Combined with the new delete delay default (1200ms → 400ms), cleanup runs complete significantly faster.

## v1.1.1

### Bug fixes
- **Webhook test error** — Fixed "Cannot find module package.json" error when testing webhooks. Now uses already-loaded version from bot module instead of relative require path.

## v1.1.0

### Features
- **Cleanup summary redesign** — Collapsible summary with timestamp, trigger badges, and clickable Run History
- **Branded Discord embeds** — "PurgeBot vX.Y.Z by ProphetSe7en" footer on all Discord notifications (cleanup, discovery, webhook test)
- **Schedule tab** — Dedicated tab with description text and dry-run warning when dryRun=true
- **Webhooks discovery tab** — Separate tab for Discord channel discovery with per-change detail display
- **Mass edit retention** — Bulk-apply default retention days across selected categories
- **Per-category deleteOld** — Individual deleteOld toggle per category

### Bug fixes
- **Log timestamps** — Fixed logs using UTC instead of container TZ

## v1.0.0

### Features
- **Web UI** — 7-tab interface (Overview, Cleanup, Sync, Statistics, Settings, Schedule, Logs)
- **Live cleanup progress** — Results build incrementally per channel via SSE
- **Global stop button** — Visible from any tab when cleanup is running
- **Statistics tab** — Charts and lifetime tracking for deleted messages
- **Channel discovery** — Auto-discover new Discord channels with sync details
- **Per-channel run** — Run cleanup on individual channels from Overview
- **Webhook test button** — Test Discord webhooks from Settings
- **Rate limiting** — 60 req/min per IP on state-changing endpoints
- **Safety guarantees** — Allow-list safety, full code review with all critical issues resolved
- **Docker-native** — PUID/PGID/UMASK, multi-platform (amd64+arm64), Alpine-based
