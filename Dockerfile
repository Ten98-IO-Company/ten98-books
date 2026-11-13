# Digests as used by the adopted foundation build; update with a tested dependency refresh.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
# Fixed pnpm for build tooling only.
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build \
 && pnpm prune --prod

FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
ARG APP_VERSION
ARG VCS_REF
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$VCS_REF
# Runtime needs only: build output, server TS sources (Node 24 native type stripping, no JSX), the shared lib
# modules they import, SQL migrations, manifest and pruned dependencies.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/src/server ./src/server
COPY --from=build --chown=node:node /app/src/lib ./src/lib
COPY --from=build --chown=node:node /app/migrations ./migrations
USER node
EXPOSE 3000
# start-web waits for a current schema (Compose sets MIGRATE_ON_START=false and migrates in its one-shot migrate
# service, the only holder of MIGRATION_DATABASE_URL), checks the application role (D-03), then loads
# .output/server/index.mjs; any failure exits non-zero without serving.
CMD ["node", "src/server/cli.ts", "start-web"]
