# One immutable image for both services. Cloud Run runs it twice:
#   gateway: node apps/gateway/src/main.ts
#   worker:  node apps/worker/src/main.ts
# Node 22 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production
USER node
CMD ["node", "apps/gateway/src/main.ts"]
