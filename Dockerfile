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
RUN cd server && npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY . .

# Ensure writable data paths (useful for Unraid bind mounts)
RUN touch prices.json settings.json && \
    mkdir -p backups && \
    chmod -R 777 prices.json settings.json backups

EXPOSE 3000
CMD ["node", "server/server.js"]
