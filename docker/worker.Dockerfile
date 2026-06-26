# UniMind iii worker — runs the write pipeline + maintenance crons, connecting to
# the iii engine (WS) and HelixDB (HTTP) over the compose network.
FROM node:24-alpine

WORKDIR /app

# curl + nc (busybox) for the readiness gate in the entrypoint.
RUN apk add --no-cache curl

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY docker/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
