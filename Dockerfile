FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bundle frontend CDN dependencies (offline support, version-pinned)
RUN mkdir -p src/ui/public/vendor && \
    wget -q -O src/ui/public/vendor/tailwind.js "https://cdn.tailwindcss.com/3.4.17" && \
    wget -q -O src/ui/public/vendor/alpine-collapse.js "https://cdn.jsdelivr.net/npm/@alpinejs/collapse@3.14.9/dist/cdn.min.js" && \
    wget -q -O src/ui/public/vendor/alpine.js "https://cdn.jsdelivr.net/npm/alpinejs@3.14.9/dist/cdn.min.js" && \
    wget -q -O src/ui/public/vendor/cronstrue.js "https://cdn.jsdelivr.net/npm/cronstrue@2.50.0/dist/cronstrue.min.js" && \
    wget -q -O src/ui/public/vendor/chart.js "https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"

COPY src/ ./src/
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
    CMD test -f /tmp/healthcheck && test $(($(date +%s) - $(cat /tmp/healthcheck))) -lt 100800 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
LABEL org.opencontainers.image.title="PurgeBot" \
      org.opencontainers.image.description="Automated Discord message cleanup with retention policies and Web UI" \
      org.opencontainers.image.source="https://github.com/ProphetSe7en/purgebot"

CMD ["node", "src/bot.js"]
