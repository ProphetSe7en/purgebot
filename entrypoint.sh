#!/bin/sh

PUID=${PUID:-99}
PGID=${PGID:-100}
UMASK=${UMASK:-002}

# Create/update group and user
addgroup -g "$PGID" -S appgroup 2>/dev/null || true
adduser -u "$PUID" -S appuser -G appgroup -H -D 2>/dev/null || true

# Set umask
umask "$UMASK"

# Copy sample config on first run
if [ -d /config ] && [ ! -f /config/config.yaml ]; then
  cp /app/config.yaml.sample /config/config.yaml
  echo "Created default config at /config/config.yaml — edit it and run --sync"
fi

# Fix ownership of config directory and all contents
[ -d /config ] && chown -R "$PUID":"$PGID" /config

echo "Starting with UID=$PUID GID=$PGID UMASK=$UMASK"

# Drop privileges and run command
exec su-exec "$PUID":"$PGID" "$@"
