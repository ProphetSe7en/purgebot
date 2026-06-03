# Security Policy

## Supported versions

| Version | Security updates |
|---------|------------------|
| `:latest` | ✅ Yes |
| `:dev` (early access) | ✅ Yes - fixes land on every dev build |

Older `:vX.Y.Z` tags are not patched in place. Pull a newer image instead.

## Reporting a vulnerability

**Please do NOT open a public GitHub issue for security bugs.** Even describing an attack path in a public forum before a fix ships puts other users at risk.

### Reporting channel

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/prophetse7en/purgebot/security/advisories/new)**

This is the only intended channel - reports stay private to maintainers, and there is no e-mail thread to leak.

### What to include

- PurgeBot version (visible in the page footer, or `cat /config/logs/purgebot-*.log | head -1`).
- Clear reproduction steps (command + request body + expected vs actual response is ideal).
- Impact assessment - what data/access can the attacker obtain?
- Your disclosure timeline preference.

### What to expect

- **Acknowledgement within 72 hours** of receipt (usually faster - solo maintainer, best-effort).
- **Triage and severity assessment within 7 days.** I'll confirm whether I accept the finding, classify severity, and propose a fix + disclosure timeline.
- **Fix within 14 days** for Critical/High findings. Medium/Low may take a release cycle.
- **Coordinated disclosure** - I'll ship a patched release first, then credit you in the CHANGELOG and this document (unless you prefer anonymity). Please do not publish details before the patch ships.

### How I handle reports

- Reporter credit in CHANGELOG + this document by default (anonymous on request).
- Honest acknowledgement when a report is valid - including in the CHANGELOG.
- Open to public discussion of a finding after the patch ships.

## Security model

PurgeBot is a **local admin tool** that talks to one Discord guild via the Discord bot gateway + REST API. The design assumes:

- You control the host where it runs.
- You do not expose port 3050 directly to the internet without a reverse proxy.
- You protect `/config/` the same way you protect Radarr/Sonarr's `config.xml` (file permissions, backup encryption, LUKS on the host).

### What PurgeBot does

- **Login required for non-LAN visitors by default.** First-run setup forces you to create an admin account - there are no default credentials. Passwords are hashed with bcrypt (cost 12) and stored in `/config/auth.json` (mode 0600). Long passwords (16+ characters) skip the upper/lower/digit/symbol class check, so passphrases are welcome.
- **LAN bypass is opt-out.** `AUTH_REQUIRED=disabled_for_local_addresses` is the default - visitors from `TRUSTED_NETWORKS` (loopback + RFC1918 + link-local + ULA by default) reach the UI without login, matching Radarr/Sonarr conventions. Flip to `AUTH_REQUIRED=enabled` to force login from anywhere. The trusted-network list is editable per install; setting `TRUSTED_NETWORKS` or `TRUSTED_PROXIES` as env vars locks those values from UI edits so a session-hijack attacker cannot widen the trust boundary without host access.
- **Brute-force protection on login.** After 5 failed attempts from the same IP within a minute, further attempts return HTTP 429 + `Retry-After: 60`. The same protection applies to `/setup`, `/api/auth/api-key/rotate`, and `/api/auth/change-password` so a stolen session cookie cannot brute-force the current password against the lax `/api/*` limit. Failed login attempts are logged with the source IP so you can wire them up to fail2ban or similar.
- **CSRF protection** on every state-changing request. Authenticated sessions verify a per-session token sent via `X-CSRF-Token`; anonymous flows (login, setup) use the cookie double-submit pattern. Constant-time compare. The middleware never falls back to the anon model when a session is authenticated but missing a token - that path returns 403 outright instead of silently downgrading.
- **API key for headless clients.** Each install gets a randomly generated 32-byte API key visible in Settings → Security. Send it as `X-API-Key: <key>` (or `?apiKey=<key>`) to bypass session auth for scripts, Homepage widgets, and other automation. Rotation requires the current password.
- **Sessions survive container restarts.** Stored on disk at `/config/sessions.json` (mode 0600), written via temp-file + rename so a crash mid-write cannot corrupt the store. 30-day TTL with rolling refresh on activity.
- **Reverse-proxy headers are honored only from configured proxies.** `X-Forwarded-For` is trusted only when the direct peer IP matches your `TRUSTED_PROXIES` CIDR list. Stops other containers on the same Docker bridge from spoofing client IPs to defeat the LAN bypass.
- **Credentials masked in API responses.** Discord webhook URLs and the Gotify token are returned as a sentinel by `GET /api/config`; saving the config back unchanged (sentinel still present) keeps the stored value. The UI shows "Saved (hidden) - type to replace" placeholders for those fields with an explicit Remove button if you want to clear them.
- **File permissions are tight.** `/config/auth.json`, `/config/sessions.json`, `/config/session-secret`, and `/config/logs/audit-*.log` are all mode 0600 - readable only by the container user. Atomic writes (temp + rename) prevent half-written state.
- **Audit log of admin actions.** Every security-relevant event is written as JSON-lines to `/config/logs/audit-YYYY-MM-DD.log` with rotation matching `logging.maxDays`. Covers: login attempts (success + failure with source IP), logout, setup, password changes, API key rotations, rate-limit hits, config writes (with the top-level field names - never the values), webhook test sends (with the host prefix - never the token), manual cleanup triggers, per-channel Discord deletes, sort moves, Purge-All channel recreations, and guild-allowlist violations. Use `jq` for forensic queries.
- **Bot-side guild allowlist.** PurgeBot operates only on the guild configured as `GUILD_ID`. If the bot token is ever leaked and the bot is invited to a guild outside the allowlist, the bot leaves that guild immediately (logged in the audit log).
- **Outbound URL host validation.** Discord webhook URLs are validated against `discord.com` / `discordapp.com` on every send (not just at test time). Gotify URLs are validated as `http://` or `https://` only. A tampered config cannot redirect cleanup summaries to an arbitrary host.
- **Bot token isolation.** The Discord bot token comes from `DISCORD_TOKEN` env and is never written to `config.yaml` or any API response. Reset the token at the Discord Developer Portal if you suspect a leak - PurgeBot picks up the new token on next container restart.
- **No privileged Discord intents.** PurgeBot requests `Guilds + GuildMessages` only. Message bodies are read via REST during scheduled scans (gated by the Read Message History bot permission), not via gateway events, so the privileged `MessageContent` intent is unnecessary. Stays below Discord's 75-server verification threshold automatically.

### What PurgeBot does NOT do (by design)

- **Terminate TLS itself.** Runs plain HTTP on port 3050. Front it with SWAG / Traefik / Caddy / Nginx Proxy Manager for HTTPS, and add the proxy's IP to `TRUSTED_PROXIES` so `X-Forwarded-Proto: https` is honored.
- **Encrypt config at rest.** `/config/config.yaml` stores webhook URLs and the Gotify token as plaintext (mode 0644 inherited from umask). `/config/auth.json` is 0600 - that's the protection. If an attacker has read access to `/config/`, no local-only key can meaningfully protect the file.
- **Bypass the Discord permission model.** PurgeBot can only delete messages the bot's role can see. If the bot lacks Read Message History or Manage Messages on a channel, the cleanup skips it (and the audit log records it as a permission gap).
- **Recover deleted messages.** Discord message deletion is permanent. PurgeBot's `Purge All` feature snapshots channel metadata (name, position, permission overwrites, webhooks) to `/config/recoveryfiles/` before deleting + recreating - but the messages themselves are gone the moment Discord processes the delete.
- **Trust the Web UI as the boundary.** Even with the auth gate up, port 3050 is the LAN's responsibility. Don't expose it directly to the internet; don't grant the Docker user broader filesystem access than the volume mount.

## Security audit trail

PurgeBot's security baseline (forms-auth, trusted networks, rate-limit, CSRF, audit log, API key, Discord-side hardening) shipped with code review at each milestone. Findings are captured as comments in the source. CI runs `npm audit --audit-level=high --omit=dev` and a syntax sweep on every push to `main` and every pull request.

Specific requests for security-relevant change details can be made via the disclosure channel above.

## Changelog of security-relevant changes

See `CHANGELOG.md` - security-related changes are called out in the entry's overview line.
