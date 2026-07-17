FROM node:22-bookworm-slim AS dependencies

ENV COREPACK_HOME=/tmp/corepack
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /workspace
COPY package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/agent-review/package.json apps/agent-review/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/k8s/package.json packages/k8s/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
COPY apps apps
COPY packages packages
ARG BUILD_SCOPE=all
RUN if [ "$BUILD_SCOPE" = "all" ]; then pnpm build; else pnpm --filter "${BUILD_SCOPE}..." build; fi

FROM node:22-bookworm-slim AS runtime-base

ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# Keep the pnpm layout intact so workspace package symlinks resolve without
# running a package manager in the runtime image.
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps ./apps
COPY --from=build /workspace/packages ./packages
RUN mkdir -p /var/log/platform \
    && ln -s ../apps/api/node_modules/pg /app/node_modules/pg \
    && chown 1000:1000 /var/log/platform

USER 1000:1000

FROM runtime-base AS api-runtime
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM runtime-base AS worker-runtime
ENV PORT=3001 \
    WORKER_HEALTH_PORT=3001
EXPOSE 3001
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime-base AS agent-review-runtime
EXPOSE 3002
CMD ["node", "apps/agent-review/dist/main.js"]

FROM nginx:1.27-alpine AS web-runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 80
