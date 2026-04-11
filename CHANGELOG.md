# Changelog

## v1.3.1

### Improvements

- **Readable helper text** — Bumped `gh-dim` from `#484f58` to `#7d8590` so all descriptive text under settings labels passes WCAG AA contrast (5.0:1) on the dark background. Affects Settings tab descriptions, stat card subtext, empty-state messages.
- **Visible secondary buttons** — Test (Cleanup/Info webhooks, Gotify), Check Permissions, and the six Overview category buttons (Enable All / Disable All / Set Retention / Sort Now ×2 / Enable All sort) now have a `bg-gh-border` raised fill and bright label text instead of disappearing into the background.

## v1.3.0

### Features

- **UI redesign** — Centered layout (960px max-width), Settings tab with sidebar navigation (Cleanup, Notifications, Schedule, Discord Tools, General). Tabs reduced from 8 to 7 (Schedule moved to Settings).
- **Per-channel retention dropdown** — Replaces toggle + input with single dropdown: Default (inherit category), Skip (never delete), or Custom (enter days). Shows effective delete range (>7d, 7-14d, etc.) based on retention + deleteOld combination.
- **Channel & Category Sorting** — Sort Discord server categories and channels alphabetically. Manual via Sort Now button or automatic after scheduled cleanup. Per-category opt-in toggles. Pinned positions (lock categories to first, last, or specific position).
- **Category grid overview** — Fixed columns (Category, Deletes, Overrides, Cleanup, Sort, Pin) replace variable-width text. Feature status visible at a glance without expanding.
- **Scheduled post-cleanup tasks** — After each scheduled cleanup: auto-sync (discover new channels), optional webhook discovery scan, optional auto-sort. Sort notifications sent to info webhook + Gotify.
- **Collapsible settings cards** — Notifications (Discord, Gotify) and Discord Tools (Webhook Discovery, Channel & Category Sorting) use expandable cards with status badges.

### Improvements

- **Deletes column** — Shows effective delete range based on retention + deleteOld: >0d (delete all), 7-14d (partial), — (nothing happens). Yellow warning when config is ineffective.
- **Descriptive labels** — "Enabled" → "Cleanup", "Default retention" → "Max age", "Include in sort" → "Sort channels". Tooltips on all controls.
- **Bulk sort actions** — Enable All / Disable All for sort inclusion alongside cleanup actions.
- **Smoother statistics charts** — No visible data points, increased curve tension.
- **Run History grid** — Fixed columns for date, badge, purged count, duration.
- **Webhooks tab** — Improved text visibility.
- **Consistent status labels** — Discord and Gotify both show "Enabled/Disabled".

### Bug fixes

- **Duplicate channel rendering** — Channels with the same name now render correctly in cleanup results (unique Alpine keys).
- **Recovery section** — No longer visible on all tabs (moved inside Settings).
- **Sort position overflow** — Per-channel setPosition instead of bulk to avoid Discord int32 limit.
- **Retention dropdown reactivity** — Uses splice() for proper Alpine detection.
- **Mass edit toast grammar** — "7 days" instead of "7 day".

## v1.2.3

### Features

- **Purge All** — New per-channel button that deletes and recreates a channel
  to instantly clear all message history. Recreates channel settings,
  permissions, and webhooks. New webhook URLs shown in a result modal.
- **Duplicate channel safety** — When multiple channels share the same name,
  a picker with channel IDs and topics lets you select the correct one.
- **Recovery system** — If channel recreation fails, a snapshot is saved to
  `/config/recovery/`. A Recovery section appears in Settings to restore
  the channel with one click.

### UI

- **Cleanup/Purge All button styling** — Cleanup buttons are green, Purge All
  is red. Clear visual distinction between safe retention-based cleanup and
  destructive full purge.
- **"Discover Webhooks" label** — Renamed from "Webhook Discovery" for
  consistency with other settings labels.
- **Number input spinners removed** — All numeric inputs now require typing
  values directly (no up/down arrows).
- **Max Old Deletes description** — Now shows timing guidance
  (e.g., "200 ≈ 80s per channel").

### API

- `POST /api/cleanup/purge-all` — Delete and recreate a channel
- `GET /api/cleanup/resolve-channels?category=Name` — List channels with IDs
- `GET /api/cleanup/recovery` — List recovery snapshots
- `POST /api/cleanup/recover` — Restore a channel from a recovery snapshot

## v1.2.2

### UI

- **Schedule tab — Enabled Categories alignment.** Switched the list
  from a flex layout with `min-w-[120px]` on the name column to a
  `grid-cols-[160px_1fr]` layout so the "channels · default" column
  stays aligned regardless of how long the category name is. Long
  names are now truncated with an ellipsis and the full name appears
  on hover.
- **Sync tab — clarified Channel Discovery description.** The text
  now explains that new categories are added disabled (but inherit
  the global default retention), and new channels in already-enabled
  categories follow the category's default retention. Also notes
  that scheduled cleanup auto-discovers before each run, so manual
  sync is only needed between runs.

### Template

- **Removed the `Timezone` (TZ) config variable.** Unraid auto-injects
  the host's timezone into containers when the template does not set
  it — and Node.js uses its bundled ICU for timezone resolution, so
  cron scheduling continues to work correctly without the variable.
  This brings purgebot in line with the clonarr template and matches
  community feedback. Existing installations keep whatever TZ they
  already had — remove the variable in the container edit screen if
  you want it to follow the host.

## v1.2.1

### Bug fixes
- **Settings autofill** — Browser password managers no longer autofill the Gotify URL/token and Discord webhook fields in Settings (added `autocomplete="one-time-code"`).

### Improvements
- **Version label** — Docker image now carries the `org.opencontainers.image.version` OCI label, injected from the git tag at build time.

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
