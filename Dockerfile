FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
RUN npx prisma generate

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json ./
EXPOSE 3001
# PRODUCTION CUTOVER Stage 1: was `prisma db push --accept-data-loss` -- db
# push diffs the live schema against schema.prisma and applies whatever it
# takes to match, including silently dropping columns/data on any drift, and
# bypasses the migration-history mechanism entirely (release.yml's separate,
# never-actually-deployed pipeline already used the correct `migrate deploy`
# here; this file did not). Since this command runs on EVERY container
# start/restart, an accidental schema/DB mismatch in a real deployment could
# have caused irreversible production data loss. `migrate deploy` only
# applies already-reviewed, committed migrations from prisma/migrations/
# (copied into this image below) and never touches data outside what a
# migration explicitly does -- it fails loudly instead of guessing.
CMD ["sh", "-c", "for i in $(seq 1 20); do npx prisma migrate deploy && break; echo 'waiting for database...'; sleep 3; done; node dist/main.js"]
