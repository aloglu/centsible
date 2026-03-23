# Multi-arch base image (amd64/arm64)
FROM node:20-bookworm-slim

# Runtime environment
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

USER root
WORKDIR /app

# Install Chromium and common runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        fonts-noto-color-emoji && \
    rm -rf /var/lib/apt/lists/*

# Install server dependencies
COPY server/package*.json ./server/
# `npm ci` gives deterministic installs from package-lock.
RUN cd server && npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY . .

# Ensure writable data paths (useful for bind mounts)
RUN mkdir -p /app/data/backups && \
    touch /app/data/prices.json /app/data/settings.json /app/data/diagnostics.json /app/data/audit.json && \
    chmod -R 777 /app/data

EXPOSE 3000
# Start only the backend; static frontend is served by Express.
CMD ["node", "server/server.js"]
