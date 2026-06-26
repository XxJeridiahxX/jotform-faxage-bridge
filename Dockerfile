# Active LTS. For production, pin by digest:
#   docker pull node:22-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
# then replace the tag below with node:22-alpine@sha256:<digest>.
FROM node:26-alpine

WORKDIR /app

# Install production deps against the committed lockfile, then fail the build on any
# high+ severity advisory (supply-chain gate).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=high

# Application code only (see .dockerignore for what is excluded).
COPY src ./src

# Persistent state dir (dedup claims + disclosure audit log); mounted as a volume at runtime.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000

# Run as the non-root user that ships with the node image.
USER node

# Container-native health check hits the bridge's /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
