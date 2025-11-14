FROM node:18-alpine

# Install required tools for gRPC queries
RUN apk add --no-cache \
    bash \
    curl \
    jq \
    tar

# Install grpcurl
RUN curl -sSL https://github.com/fullstorydev/grpcurl/releases/download/v1.8.9/grpcurl_1.8.9_linux_x86_64.tar.gz | \
    tar -xz -C /usr/local/bin grpcurl && \
    chmod +x /usr/local/bin/grpcurl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy gateway server
# ⚠️ IMPORTANT: Use your actual filename here
COPY gatewayserver.js ./
# If you renamed the file, use:
# COPY radiant-gateway-grpc.js ./gatewayserver.js

# Create cache directory
RUN mkdir -p /app/cache

# Verify tools are installed
RUN grpcurl --version && jq --version && node --version

EXPOSE 3001

# Start the server
CMD ["node", "gatewayserver.js"]