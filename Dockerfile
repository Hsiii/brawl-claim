FROM oven/bun:1.3.9

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3100
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ARG INSTALL_PLAYWRIGHT_BROWSERS=true

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN if [ "$INSTALL_PLAYWRIGHT_BROWSERS" = "true" ]; then bunx playwright install --with-deps chromium; fi
RUN apt-get update && apt-get install -y --no-install-recommends xauth && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY tsconfig.json ./tsconfig.json
RUN mkdir -p /app/state && chown -R bun:bun /app/state

USER bun

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:3100/api/health'); if (!response.ok) process.exit(1);"]

CMD ["bun", "run", "start"]
