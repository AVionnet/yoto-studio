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
#
# YouTube chiffre ses URLs de flux avec un challenge JS (signature/n) que yt-dlp ne sait résoudre
# qu'avec un runtime JS ; sans lui, l'extraction échoue avec "Requested format is not available"
# même une fois le blocage anti-bot passé. Deno est le seul runtime activé par défaut.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl unzip \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && DENO_ARCH=$(uname -m | sed -e 's/x86_64/x86_64-unknown-linux-gnu/' -e 's/aarch64/aarch64-unknown-linux-gnu/') \
 && curl -fsSL "https://github.com/denoland/deno/releases/latest/download/deno-${DENO_ARCH}.zip" -o /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin && rm /tmp/deno.zip && chmod +x /usr/local/bin/deno \
 && apt-get purge -y curl unzip && apt-get autoremove -y \
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
