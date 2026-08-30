# -----------------------------------------------------------------------------
# AYROVI Warehouse Core — Backend (NestJS) — Production-ready image
# Multi-stage build: heavy deps stay in the builder, the runtime is slim.
# -----------------------------------------------------------------------------

# ---- Builder stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install all deps (including dev) to allow the build.
COPY backend/package*.json ./
RUN npm ci

# Copy source and build.
COPY backend/ ./
RUN npx prisma generate \
    && npm run build \
    && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Node runs as a non-root user.
USER node

# Copy built artifacts from the builder.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

EXPOSE 3000

# Apply migrations (in production we use `prisma migrate deploy`) then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
