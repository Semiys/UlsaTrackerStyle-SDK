FROM node:24.21.0-bookworm-slim AS lab-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM lab-dependencies AS dependencies
RUN npm ci --omit=dev --no-audit --no-fund

FROM dependencies AS test
COPY src ./src
COPY test ./test
COPY public ./public
COPY views ./views
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
ENV NODE_ENV=production PORT=8080 DATA_DIR=/app/data STORAGE_BACKEND=json DEMO_MODE=1
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]

FROM dependencies AS runtime
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
