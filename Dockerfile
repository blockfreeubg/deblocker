# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips building bufferutil's optional native addon (no ARM64 prebuild; ws falls back to plain JS).
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
	CMD node -e "const b=(process.env.BASE_PATH||'').replace(/^\/+|\/+$/g,'');fetch('http://127.0.0.1:'+(process.env.PORT||8080)+(b?'/'+b+'/':'/')+'api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
