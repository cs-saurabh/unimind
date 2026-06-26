# Dockerfile for Helix Dashboard (Next.js only)
# Build context is this folder (unimind-dashboard) — the app lives at the context root.
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --no-audit --no-fund

# Copy app source
COPY . ./

# Build the application
RUN npm run build

# Production image
FROM node:18-alpine AS runtime

WORKDIR /app

# Copy built application
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/next.config.* ./
COPY --from=builder /app/src ./src

# Create helixdb-cfg directory for configuration files
RUN mkdir -p helixdb-cfg

# Expose only the Next.js port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Start the Next.js application
CMD ["npm", "start"]
