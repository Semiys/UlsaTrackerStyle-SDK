FROM --platform=$BUILDPLATFORM node:24.22.2-bookworm-slim AS build
WORKDIR /workspace/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY public/ /workspace/public/
RUN npm run build

FROM node:24.22.2-bookworm-slim AS runtime
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /workspace/frontend/dist ./dist
COPY frontend/server.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node","server.mjs"]
