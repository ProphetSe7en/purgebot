FROM node:26-alpine

ARG VERSION=dev

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Tailwind CLI (standalone binary - no npm devDep, no Node runtime cost).
# Compiles src/ui/css/input.css to a static stylesheet at build time, so
# the browser never loads the runtime JIT compiler. Closes the
# "cdn.tailwindcss.com should not be used in production" console warning.
RUN apk add --no-cache --virtual .build-deps curl && \
    curl -fsSL --retry 3 -o /usr/local/bin/tailwindcss \
      "https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64" && \
    echo "7d24f7fa191d2193b78cd5f5a42a6093e14409521908529f42d80b11fde1f1d4  /usr/local/bin/tailwindcss" | sha256sum -c - && \
    chmod +x /usr/local/bin/tailwindcss

# Bundle remaining frontend CDN dependencies (offline support, version-pinned).
# Each checksum matches the same file inside the package's npm tarball, so a
# tampered CDN copy fails the build instead of shipping.
RUN mkdir -p src/ui/public/vendor && cd src/ui/public/vendor && \
    wget -q -O alpine-collapse.js "https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.14.9/dist/cdn.min.js" && \
    wget -q -O alpine.js "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" && \
    wget -q -O cronstrue.js "https://cdn.jsdelivr.net/npm/cronstrue@2.50.0/dist/cronstrue.min.js" && \
    wget -q -O chart.js "https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.js" && \
    printf '%s\n' \
      "c7661d4e2cf0465e3cd693190debb5f592ac72dcc4cfe650581273767558b27b  alpine-collapse.js" \
      "3ed1eed252488921df65e363d6715deb04d7f92aaedb9e52199fdf73cb1e0ad3  alpine.js" \
      "970ae0daaa81c0e9bfcfb912f5d18b8f38066275c8133f447e0f79ecfb1d3a7e  cronstrue.js" \
      "e4cf4d144b222634f2e64ff707cd57b953f8de4b65b231cd5ac6bde114648e4d  chart.js" \
    | sha256sum -c -

COPY tailwind.config.js ./
COPY src/ ./src/

# Compile Tailwind: scans index.html + login.html + setup.html for used
# classes, emits a minified styles.css next to the rest of the UI assets.
# components.css is appended afterwards because the standalone CLI doesn't
# process @import directives that appear after @tailwind.
RUN mkdir -p src/ui/public/css && \
    tailwindcss -i src/ui/css/input.css -o src/ui/public/css/styles.css --minify && \
    cat src/ui/css/components.css >> src/ui/public/css/styles.css && \
    apk del .build-deps && \
    rm /usr/local/bin/tailwindcss
COPY config.yaml.sample ./config.yaml.sample
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /config

ENV TZ=UTC
ENV PUID=99
ENV PGID=100
ENV UMASK=002
EXPOSE 3050

HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
    CMD test -f /tmp/healthcheck && test $(($(date +%s) - $(cat /tmp/healthcheck))) -lt 900 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
LABEL org.opencontainers.image.title="PurgeBot" \
      org.opencontainers.image.description="Automated Discord message cleanup with retention policies and Web UI" \
      org.opencontainers.image.source="https://github.com/prophetse7en/purgebot" \
      org.opencontainers.image.version="${VERSION}"

CMD ["node", "src/bot.js"]
