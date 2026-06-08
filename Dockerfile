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
    curl -sSL -o /usr/local/bin/tailwindcss \
      "https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64" && \
    chmod +x /usr/local/bin/tailwindcss

# Bundle remaining frontend CDN dependencies (offline support, version-pinned).
RUN mkdir -p src/ui/public/vendor && \
    wget -q -O src/ui/public/vendor/alpine-collapse.js "https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.14.9/dist/cdn.min.js" && \
    wget -q -O src/ui/public/vendor/alpine.js "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" && \
    wget -q -O src/ui/public/vendor/cronstrue.js "https://cdn.jsdelivr.net/npm/cronstrue@2.50.0/dist/cronstrue.min.js" && \
    wget -q -O src/ui/public/vendor/chart.js "https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"

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
