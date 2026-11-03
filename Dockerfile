FROM node:24.21.0-bookworm-slim AS lab-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM lab-dependencies AS dependencies
RUN npm ci --omit=dev --no-audit --no-fund

FROM dependencies AS test
COPY frontend/server.mjs ./frontend/server.mjs
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
COPY grafana ./grafana
COPY sdk/js ./sdk/js
CMD ["npm", "test"]

FROM lab-dependencies AS lab2-test
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
CMD ["npm", "run", "test:lab2"]

FROM lab-dependencies AS lab2
COPY src ./src
COPY public ./public
COPY views ./views
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data STORAGE_BACKEND=json DEMO_MODE=1 LAB_IMAGE_VERSION=0.0.2
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]

FROM lab-dependencies AS lab3-test
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
CMD ["npm", "run", "test:lab3"]

FROM lab-dependencies AS lab3
COPY src ./src
COPY public ./public
COPY views ./views
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data STORAGE_BACKEND=clickhouse DEMO_MODE=1 LAB_IMAGE_VERSION=0.0.3
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]

FROM dependencies AS duckdb-runtime
COPY src ./src
COPY public ./public
COPY views ./views
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV STORAGE_BACKEND=json
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]

FROM --platform=$BUILDPLATFORM node:24.21.0-bookworm-slim AS grafana-plugin
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY scripts/download-grafana-plugin.mjs /build/download-grafana-plugin.mjs
RUN node /build/download-grafana-plugin.mjs "$TARGETARCH"

FROM lab-dependencies AS lab4-test
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
COPY grafana ./grafana
COPY sdk/js ./sdk/js
CMD ["npm", "run", "test:lab4"]

FROM lab3 AS lab4
USER root
COPY grafana ./grafana
COPY --from=grafana-plugin /bundle /opt/ulsatracker/grafana-plugins
RUN chmod -R a+rX /opt/ulsatracker/grafana-plugins
ENV LAB_IMAGE_VERSION=0.0.4
EXPOSE 3000
USER node

FROM lab4 AS runtime


# Current product/monitoring release. Reproduce historical labs from their tagged source.
FROM node:24.22.2-bookworm-slim AS monitoring-dependencies
WORKDIR /app
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM monitoring-dependencies AS monitoring-test
COPY frontend/server.mjs ./frontend/server.mjs
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
COPY grafana ./grafana
COPY sdk/js ./sdk/js
CMD ["npm", "run", "test:release"]

FROM --platform=$BUILDPLATFORM node:24.22.2-bookworm-slim AS monitoring-plugin
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY scripts/download-monitoring-plugin.mjs /build/download-monitoring-plugin.mjs
RUN node /build/download-monitoring-plugin.mjs "$TARGETARCH"

FROM monitoring-dependencies AS monitoring-runtime
COPY src ./src
COPY public ./public
COPY views ./views
COPY grafana ./grafana
COPY sdk/js ./sdk/js
COPY --from=monitoring-plugin /bundle /opt/ulsatracker/grafana-plugins
RUN mkdir -p /app/data && chown node:node /app/data && chmod -R a+rX /opt/ulsatracker/grafana-plugins
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data STORAGE_BACKEND=clickhouse LAB_IMAGE_VERSION=0.11.1
EXPOSE 8080 3000 9100
USER node
CMD ["node", "src/server.js"]
