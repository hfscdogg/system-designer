# One immutable image for both services. Cloud Run runs it twice:
#   gateway: node apps/gateway/src/main.ts
#   worker:  node apps/worker/src/main.ts
# Node 22 runs the TypeScript sources directly (type stripping), so there is no build step.
# The Playwright image carries Chromium (for PDF rendering) and its fonts and libraries;
# its version matches the pinned playwright-core in packages/render.
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production
USER pwuser
CMD ["node", "apps/gateway/src/main.ts"]
