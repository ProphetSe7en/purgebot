# Changelog

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
