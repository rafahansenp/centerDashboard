FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/pii/package.json packages/pii/
COPY packages/entitlements/package.json packages/entitlements/
COPY packages/secrets/package.json packages/secrets/
COPY packages/uappi-client/package.json packages/uappi-client/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mcp-core/package.json packages/mcp-core/
COPY packages/mcp-commerce/package.json packages/mcp-commerce/
COPY packages/mcp-ga4/package.json packages/mcp-ga4/
COPY packages/mcp-behavior/package.json packages/mcp-behavior/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @center/api exec prisma generate
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app ./
# Entrypoint padrão: API. Os workers sobrescrevem o command no compose.
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
