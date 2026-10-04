FROM node:24.21.0-bookworm-slim
ARG REVISION=local
LABEL org.opencontainers.image.revision=$REVISION
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /rails
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build:assets && mkdir -p storage && chown -R node:node storage
ENV HTTP_PORT=80 CAMPFIRE_STORAGE_PATH=/rails/storage NODE_ENV=production
USER node
EXPOSE 80
CMD ["node", "src/server.js"]
