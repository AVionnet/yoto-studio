# syntax=docker/dockerfile:1

# --- Compilation -------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Exécution ---------------------------------------------------------------
FROM node:22-bookworm-slim

# ffmpeg découpe et transcode ; yt-dlp ingère les vidéos. Les paquets Debian de yt-dlp sont
# systématiquement trop vieux — YouTube casse l'outil toutes les quelques semaines — donc on
# prend le binaire officiel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public ./public

# La base et les fichiers de travail vivent dans des volumes : un redéploiement ne les touche pas.
ENV NODE_ENV=production DATA_DIR=/data MEDIA_DIR=/media PORT=3000
RUN useradd --system --uid 10001 yoto \
 && mkdir -p /data /media && chown yoto:yoto /data /media
USER yoto

EXPOSE 3000
CMD ["node", "dist/server.js"]
