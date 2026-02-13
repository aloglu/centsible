# Use Node.js base image with Puppeteer dependencies
FROM ghcr.io/puppeteer/puppeteer:latest

# Set environment variables
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Switch to root to install dependencies and set up permissions
USER root

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json from the server directory
COPY server/package*.json ./server/

# Install dependencies in the server directory
RUN cd server && npm install --production

# Copy the rest of the application code
COPY . .

# Set permissions for the data files and backups folder
# This ensures Docker can write to these files/folders on Unraid
RUN touch prices.json settings.json && \
    mkdir -p backups && \
    chmod -R 777 prices.json settings.json backups

# Expose the API port
EXPOSE 3000

# Run the server
CMD ["node", "server/server.js"]
