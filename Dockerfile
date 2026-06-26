FROM node:18-alpine

WORKDIR /app

# Install production dependencies against the committed lockfile (reproducible).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code only (see .dockerignore for what is excluded).
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# Run as the non-root user that ships with the node image.
USER node

# Container-native health check hits the bridge's /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
