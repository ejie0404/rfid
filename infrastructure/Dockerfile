FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /workspace

# The API and its workspace packages compile from the committed lockfile. Pruning after build
# keeps TypeScript, tsx, and other development-only packages out of the runtime image.
COPY . .
RUN npm ci --include=dev \
    && npm run build:packages \
    && npm run build --workspace=@smartgate/api \
    && npm prune --omit=dev \
    && npm cache clean --force

USER node

FROM runtime AS worker
HEALTHCHECK NONE
CMD ["node", "apps/api/dist/move-out-worker-main.js"]

FROM runtime AS api
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "infrastructure/check-api-readiness.mjs"]
CMD ["node", "apps/api/dist/main.js"]
