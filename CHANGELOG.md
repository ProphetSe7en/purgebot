# Changelog

## v1.5.0

Web UI gets a login layer, an audit log, and an API key for headless clients. Rules now show you exactly which rule and which condition caused each delete, with a Run button per rule for one-off runs without changing the schedule. Existing installs keep working with no configuration changes.

### Highlights

- Web UI login, with LAN bypass on by default so home users see no friction.
- API key for Homepage widgets and other headless integrations.
- Audit log records security-relevant events as JSON lines, ready for `jq`.
- Per-message attribution in cleanup results so you can see why each message was deleted.
- Run a single rule on demand without waiting for the next scheduled cleanup.
- URL routing: every tab and Settings page is bookmarkable and opens in a new tab.

### New

#### Web UI auth and audit

**Web UI login.** First-run setup forces you to create an admin account. Once set, login is required from outside the LAN by default and friction-free from inside the LAN. Sessions survive container restarts. Passwords use bcrypt with a 16+ character passphrase exception to the class-mix rule. Brute-force protection: 5 login attempts per IP then 1 per minute, with `Retry-After` headers so honest retries know when to come back.

**Settings, Security tab.** Shows your current auth posture (LAN bypass mode, signed-in account), the API key with Show, Hide, Copy, and Rotate, and a Change password button. Rotating the key or changing your password requires the current password.

**API key for headless clients.** Each install gets a 32-byte key shown under Settings, Security. Send it as `X-API-Key: <key>` header (or `?apiKey=<key>` query string) to bypass session auth for Homepage widgets, scripts, and other automation. Rotate without restarting the container.

**Trusted networks and reverse proxy support.** New env vars `AUTH_REQUIRED`, `TRUSTED_NETWORKS`, and `TRUSTED_PROXIES`. Defaults match Radarr and Sonarr: LAN bypass on by default with loopback, RFC 1918, link-local, and ULA ranges trusted. Setting any of these via env locks the value from UI edits so a session-hijack attacker cannot widen the trust boundary without host access.

**Audit log.** `/config/logs/audit-YYYY-MM-DD.log` records security-relevant events as JSON lines: login attempts (success and failure with source IP), logout, setup, password changes, API key rotations, rate-limit hits, config writes (top-level field names only, never values), webhook test sends (host prefix only, never the token), manual cleanup triggers, per-channel Discord deletes, sort moves, Purge All channel recreations, and guild-allowlist violations. File mode 0600. Rotates with the same `logging.maxDays` setting as the runtime log. Use `jq` for forensic queries.

**CSRF on every state-changing request.** Per-session token sent via `X-CSRF-Token` for authenticated sessions, cookie double-submit for login and setup. Constant-time compare.

**Credential masking on `/api/config`.** Webhook URLs and the Gotify token never leave the server in plaintext. The UI shows "Saved (hidden), type to replace" placeholders with an explicit Remove button if you actually want to clear the field.

#### Rules: see what fired and why

**Per-message attribution in cleanup results.** Every deleted message now shows up under Show details with a timestamp, snippet, and the reason it was deleted: which rule plus which condition matched, or "retention: >7d" for age-based. Per-channel rollup says "5 by rule, 2 by retention, +12 waiting" so the count is interpretable without opening the log.

**Scan-window context per channel.** Each channel result shows how many messages were actually scanned and how far back, with a hint to raise Max Messages Per Channel if the window was not exhausted. "0 to delete" stops being ambiguous: you can see whether the bot looked at the whole channel or stopped at the limit.

**Run one rule on demand.** Each rule card gets a Run button next to Edit and Remove. Opens a modal with Dry run and Run live buttons. The run isolates that one rule: retention is treated as "never" and other rules are skipped, so the result is purely what that rule catches. Good for "does this rule still do what I think it does" without waiting for the schedule.

**Word matching now respects word boundaries.** Typing `test` matches the word "test" but not "Testaments", "Greatest", or "latest". Old behaviour was substring match. Falls back to substring for values with non-ASCII letters (e.g. Norwegian diacritics) or non-word edges, where word-boundary semantics do not work cleanly.

**Discord notification breakdown.** Per-category cleanup embeds now report `5 purged (3 by rule, 2 by retention), scanned 5,000 (whole channel)` per channel. Rule-only runs lead with the rule that fired. Run summary adds total scanned plus the rule vs retention split.

#### UI polish

**URL routing.** Tabs and Settings sub-tabs are now reflected in the URL as `#cleanup`, `#settings/security`, etc. Browser back and forward work, bookmarks work, and middle-click, Ctrl+click, or right-click "Open in new tab" all open that page in a new browser tab. Direct links can be shared with other admins.

**Unsaved-changes warning.** The browser's native "Leave site?" dialog now appears when you try to close the tab, refresh, or navigate away with pending config changes.

**Auto-save on rule add, edit, and remove.** No more "save the rule, then save the config" two-step. Rule CRUD persists immediately.

**UI Scale.** Under Settings, Display: Compact (1.0), Default (1.1), Large (1.2). Per-browser preference, persists across reloads, applies before the page paints to avoid a resize flash on load.

**Display sub-tab in Settings.** Groups UI Scale, Time Format, and the placeholder for theme switching (light theme arrives in a later release). General now carries log retention only.

### Changed

**Compiled stylesheet.** The Web UI switched from the Tailwind runtime JIT compiler to a build-time compiled stylesheet. The "cdn.tailwindcss.com should not be used in production" console warning is gone, the CSS bundle dropped from around 350KB to 21KB, and color values now live in `tokens.css` as CSS variables so the future light theme can drop in without rewriting markup.

### Fixed

**Sort Server now uses the configured guild.** Previously `sortServer` and the permission check used the first guild in the bot's cache instead of the configured `GUILD_ID`. If the bot was ever a member of more than one server, sort could have scrambled the wrong one. Both now scope explicitly to `GUILD_ID`.

**"Delete old (>14d)" no longer silently blocks rule-matched messages older than 14 days.** Previously a rule that wanted to delete a >14-day message was silently dropped when the category had Delete old off. The toggle now only gates retention-based (age) cleanup. Rules always run regardless. Tooltip text updated.

**Rule editor dropdown stays on the saved type when editing.** Previously the condition-type dropdown always reverted to "Word" the moment you opened the modal on an existing rule. It now keeps whatever type the rule was saved with.

**Overview "Sort 37/29" badge matches reality.** `sortInclude`, `sortPinned`, and `sortSkip` used to keep entries for categories that no longer existed in config, often because the user had switched Discord server. Stale entries are now pruned on read so the badge count matches what is actually there.

### Security

**Bot leaves any guild outside `GUILD_ID` immediately.** Self-defense against a leaked bot token: a `guildCreate` listener now logs a WARN and exits any unexpected guild as soon as it arrives.

**Outbound webhook host validation on every send.** Production cleanup summary, info webhook, and Gotify pushes now validate the URL host before sending, not just at test time. A tampered config cannot redirect cleanup data to an arbitrary host.

### Upgrade

- Default behaviour for existing users: nothing changes. LAN bypass keeps the UI friction-free on your home network.
- To opt into login: visit `/setup` and create an admin account. Once set, external visitors must log in.
- To force login from everywhere (including LAN): set `AUTH_REQUIRED=enabled` in the container env.
- The audit log starts a new file daily at `/config/logs/audit-YYYY-MM-DD.log` (mode 0600). Existing log retention setting controls rotation.

## v1.4.0

See where your cleanup time goes, and understand the warnings.

### Added

- **Per-channel time in the run results.** Each channel now shows how long it took, so you can tell at a glance which channel is taking the time instead of reading the log. Each category shows its total time too.
- **Plain-language warnings and errors per channel.** When a channel has something to flag, it now appears right in the run results with a clear explanation, so you don't have to open the log. For example, a channel with many messages older than 14 days shows how many are still waiting and roughly how many more runs it needs. A permission problem shows what to check.
- **"Waiting on Discord" time.** When a run is slow, PurgeBot now shows how much of the time was spent waiting on Discord's own rate limit rather than PurgeBot being slow. Removing messages older than 14 days is limited by Discord to roughly one every few seconds, and this makes that visible. It appears next to the channel time and as a per-run summary line in the log.

### Changed

- **Notifications now include timing.** The per-category Discord message and the run summary now show how long each category took, plus a note about any channels still working through older messages.
- **Clearer guidance on the "Max Old Deletes Per Channel" setting.** The help text now explains that messages older than 14 days are removed one at a time under Discord's rate limit, so a higher number means a longer run.

## v1.3.2

Healthcheck fix. PurgeBot's Docker healthcheck tied liveness to "did a scheduled cleanup run complete recently", which is wrong - a healthcheck should verify the process is alive and responsive, not that it has done application-level work lately.

### Fixed

- **Container no longer flaps unhealthy → restart every 28 hours when `scheduleEnabled: false`.** The healthcheck rule required `/tmp/healthcheck` to be fresher than 100 800 s (28 h), but `writeHeartbeat()` was only called on startup and after a successful scheduled cleanup. Users who disabled the schedule (UI-only / manual-purge workflows) never saw the heartbeat updated after startup → 28 h later Docker marked the container unhealthy → restart → new heartbeat → repeat. Perfect 28 h restart loop, observed cleanly in logs. Fix: `setInterval(writeHeartbeat, 5 * 60 * 1000)` in `clientReady`. Heartbeat now reflects process liveness (what a healthcheck is actually for), independent of whether cleanup ran.
- **Healthcheck cutoff reduced from 100 800 s (28 h) to 900 s (15 min).** With the heartbeat now updated every 5 min, 15 min gives a 3× buffer. Brings the fail-fast window down from "missed a whole day" to "missed three heartbeats".

### Notes

- No breaking changes. No config changes. Schedule-enabled users see no behavioural difference.
- If you had PurgeBot configured for UI-only use with `scheduleEnabled: false`, the 1/day restart loop stops on upgrade.

## v1.3.1

### Improvements

- **Readable helper text** - Bumped `gh-dim` from `#484f58` to `#7d8590` so all descriptive text under settings labels passes WCAG AA contrast (5.0:1) on the dark background. Affects Settings tab descriptions, stat card subtext, empty-state messages.
- **Visible secondary buttons** - Test (Cleanup/Info webhooks, Gotify), Check Permissions, and the six Overview category buttons (Enable All / Disable All / Set Retention / Sort Now ×2 / Enable All sort) now have a `bg-gh-border` raised fill and bright label text instead of disappearing into the background.

## v1.3.0

### Features

- **UI redesign** - Centered layout (960px max-width), Settings tab with sidebar navigation (Cleanup, Notifications, Schedule, Discord Tools, General). Tabs reduced from 8 to 7 (Schedule moved to Settings).
- **Per-channel retention dropdown** - Replaces toggle + input with single dropdown: Default (inherit category), Skip (never delete), or Custom (enter days). Shows effective delete range (>7d, 7-14d, etc.) based on retention + deleteOld combination.
- **Channel & Category Sorting** - Sort Discord server categories and channels alphabetically. Manual via Sort Now button or automatic after scheduled cleanup. Per-category opt-in toggles. Pinned positions (lock categories to first, last, or specific position).
- **Category grid overview** - Fixed columns (Category, Deletes, Overrides, Cleanup, Sort, Pin) replace variable-width text. Feature status visible at a glance without expanding.
- **Scheduled post-cleanup tasks** - After each scheduled cleanup: auto-sync (discover new channels), optional webhook discovery scan, optional auto-sort. Sort notifications sent to info webhook + Gotify.
- **Collapsible settings cards** - Notifications (Discord, Gotify) and Discord Tools (Webhook Discovery, Channel & Category Sorting) use expandable cards with status badges.

### Improvements

- **Deletes column** - Shows effective delete range based on retention + deleteOld: >0d (delete all), 7-14d (partial), - (nothing happens). Yellow warning when config is ineffective.
- **Descriptive labels** - "Enabled" → "Cleanup", "Default retention" → "Max age", "Include in sort" → "Sort channels". Tooltips on all controls.
- **Bulk sort actions** - Enable All / Disable All for sort inclusion alongside cleanup actions.
- **Smoother statistics charts** - No visible data points, increased curve tension.
- **Run History grid** - Fixed columns for date, badge, purged count, duration.
- **Webhooks tab** - Improved text visibility.
- **Consistent status labels** - Discord and Gotify both show "Enabled/Disabled".

### Bug fixes

- **Duplicate channel rendering** - Channels with the same name now render correctly in cleanup results (unique Alpine keys).
- **Recovery section** - No longer visible on all tabs (moved inside Settings).
- **Sort position overflow** - Per-channel setPosition instead of bulk to avoid Discord int32 limit.
- **Retention dropdown reactivity** - Uses splice() for proper Alpine detection.
- **Mass edit toast grammar** - "7 days" instead of "7 day".

## v1.2.3

### Features

- **Purge All** - New per-channel button that deletes and recreates a channel
  to instantly clear all message history. Recreates channel settings,
  permissions, and webhooks. New webhook URLs shown in a result modal.
- **Duplicate channel safety** - When multiple channels share the same name,
  a picker with channel IDs and topics lets you select the correct one.
- **Recovery system** - If channel recreation fails, a snapshot is saved to
  `/config/recovery/`. A Recovery section appears in Settings to restore
  the channel with one click.

### UI

- **Cleanup/Purge All button styling** - Cleanup buttons are green, Purge All
  is red. Clear visual distinction between safe retention-based cleanup and
  destructive full purge.
- **"Discover Webhooks" label** - Renamed from "Webhook Discovery" for
  consistency with other settings labels.
- **Number input spinners removed** - All numeric inputs now require typing
  values directly (no up/down arrows).
- **Max Old Deletes description** - Now shows timing guidance
  (e.g., "200 ≈ 80s per channel").

### API

- `POST /api/cleanup/purge-all` - Delete and recreate a channel
- `GET /api/cleanup/resolve-channels?category=Name` - List channels with IDs
- `GET /api/cleanup/recovery` - List recovery snapshots
- `POST /api/cleanup/recover` - Restore a channel from a recovery snapshot

## v1.2.2

### UI

- **Schedule tab - Enabled Categories alignment.** Switched the list
  from a flex layout with `min-w-[120px]` on the name column to a
  `grid-cols-[160px_1fr]` layout so the "channels · default" column
  stays aligned regardless of how long the category name is. Long
  names are now truncated with an ellipsis and the full name appears
  on hover.
- **Sync tab - clarified Channel Discovery description.** The text
  now explains that new categories are added disabled (but inherit
  the global default retention), and new channels in already-enabled
  categories follow the category's default retention. Also notes
  that scheduled cleanup auto-discovers before each run, so manual
  sync is only needed between runs.

### Template

- **Removed the `Timezone` (TZ) config variable.** Unraid auto-injects
  the host's timezone into containers when the template does not set
  it - and Node.js uses its bundled ICU for timezone resolution, so
  cron scheduling continues to work correctly without the variable.
  This brings purgebot in line with the clonarr template and matches
  community feedback. Existing installations keep whatever TZ they
  already had - remove the variable in the container edit screen if
  you want it to follow the host.

## v1.2.1

### Bug fixes
- **Settings autofill** - Browser password managers no longer autofill the Gotify URL/token and Discord webhook fields in Settings (added `autocomplete="one-time-code"`).

### Improvements
- **Version label** - Docker image now carries the `org.opencontainers.image.version` OCI label, injected from the git tag at build time.

## v1.2.0

### Features
- **Gotify push notifications** - Configurable Gotify support for cleanup summaries and auto-discovery notifications. Per-level priority toggles (Warning/Info) with customizable priority values. Gotify receives a combined summary with per-category breakdown instead of individual per-category messages.
- **Gotify settings UI** - Collapsible Gotify section in Settings with enable toggle, URL/token fields, test button, and priority configuration.
- **Configurable delete delay** - New `delayBetweenDeletes` setting (default 400ms, min 200ms) controls pause between individual old message deletes (>14 days).
- **Auto-cleanup of deleted channels** - Channels and categories deleted from Discord are automatically removed from config during discovery, with notifications showing what was removed and which category it belonged to.

### Improvements
- **Faster cleanup runs** - `delayBetweenChannels` default reduced from 2000ms to 500ms. Delay is now skipped entirely when a channel had nothing to delete. Combined with the new delete delay default (1200ms → 400ms), cleanup runs complete significantly faster.

## v1.1.1

### Bug fixes
- **Webhook test error** - Fixed "Cannot find module package.json" error when testing webhooks. Now uses already-loaded version from bot module instead of relative require path.

## v1.1.0

### Features
- **Cleanup summary redesign** - Collapsible summary with timestamp, trigger badges, and clickable Run History
- **Branded Discord embeds** - "PurgeBot vX.Y.Z by ProphetSe7en" footer on all Discord notifications (cleanup, discovery, webhook test)
- **Schedule tab** - Dedicated tab with description text and dry-run warning when dryRun=true
- **Webhooks discovery tab** - Separate tab for Discord channel discovery with per-change detail display
- **Mass edit retention** - Bulk-apply default retention days across selected categories
- **Per-category deleteOld** - Individual deleteOld toggle per category

### Bug fixes
- **Log timestamps** - Fixed logs using UTC instead of container TZ

## v1.0.0

### Features
- **Web UI** - 7-tab interface (Overview, Cleanup, Sync, Statistics, Settings, Schedule, Logs)
- **Live cleanup progress** - Results build incrementally per channel via SSE
- **Global stop button** - Visible from any tab when cleanup is running
- **Statistics tab** - Charts and lifetime tracking for deleted messages
- **Channel discovery** - Auto-discover new Discord channels with sync details
- **Per-channel run** - Run cleanup on individual channels from Overview
- **Webhook test button** - Test Discord webhooks from Settings
- **Rate limiting** - 60 req/min per IP on state-changing endpoints
- **Safety guarantees** - Allow-list safety, full code review with all critical issues resolved
- **Docker-native** - PUID/PGID/UMASK, multi-platform (amd64+arm64), Alpine-based
