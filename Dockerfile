# Shared multi-stage image for all three NestJS apps.
# Pick the app at runtime via the APP build/runtime arg (core-api|watcher|notifier).
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate && npm run build:all

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts && npx prisma generate && npm cache clean --force
COPY --from=builder /app/dist ./dist

# Drop root: the node:alpine image ships an unprivileged `node` user (uid 1000).
# All copied files are world-readable, so the runtime needs no write access.
USER node

ARG APP=core-api
ENV APP=${APP}
CMD ["sh", "-c", "node dist/apps/$APP/main"]
