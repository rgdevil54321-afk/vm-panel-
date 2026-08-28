FROM node:20-bookworm-slim

# Install system virtualization dependencies and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-x86 \
    qemu-utils \
    cloud-image-utils \
    wget \
    openssl \
    curl \
    ca-certificates \
    procps \
    iproute2 \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source and assets
COPY . .

# Ensure entrypoint script is executable
RUN chmod +x /app/entrypoint.sh

# Production Environment Variables
ENV NODE_ENV=production \
    PORT=3001 \
    API_PORT=3002 \
    ROOT_DIR=/app

# Expose Web Interface (3001), API (3002), and VM Port Forwarding Range
EXPOSE 3001 3002 

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3001/ || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "src/server.js"]
