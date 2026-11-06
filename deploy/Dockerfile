# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# OpenCode Router Gateway — production image
#
#   docker build -t opencode-router-gateway .
#   docker run -d --name orgw -p 3000:3000 --env-file .env \
#     -v "$PWD/data:/app/data" opencode-router-gateway
#
# Build args:
#   XRAY_BASE  base URL for the Xray-core release download. Point this at a
#              mirror (e.g. https://gh-proxy.com/https://github.com) when
#              github.com is unreachable from your build host.
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

# ------------------------------- build stage -------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .
RUN npm run build

# Drop dev-only packages but keep the compiled frontend.
RUN npm prune --omit=dev --no-audit --no-fund

# ------------------------------ runtime stage ------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ARG XRAY_VERSION=v26.10.31
ARG XRAY_BASE=https://github.com
ARG TARGETARCH=amd64

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Xray-core (the egress engine). amd64/arm64 only.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) XARCH=64 ;; \
      arm64) XARCH=arm64-v8a ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /app/bin; \
    curl -fsSL "${XRAY_BASE}/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XARCH}.zip" -o /tmp/xray.zip; \
    unzip -q -o /tmp/xray.zip xray geoip.dat geosite.dat -d /app/bin/; \
    chmod +x /app/bin/xray; \
    rm -f /tmp/xray.zip; \
    /app/bin/xray version

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/tests ./tests
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/v1/health || exit 1

CMD ["node", "--max-old-space-size=512", "dist/backend/server.js"]
