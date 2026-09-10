# --- Stage 1: build the frontend -------------------------------------------
FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Stage 2: runtime -------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./
COPY --from=webbuild /app/web/dist /app/web/dist

# SQLite lives on a mounted volume in production (docker-compose sets this).
ENV DB_PATH=/data/data.db
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3001
CMD ["node", "index.js"]
