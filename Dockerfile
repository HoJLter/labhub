# lab-hub — продакшн-образ: Node 22 + LibreOffice (DOCX→PDF) + ffmpeg (постеры видео) + git (Obsidian Git sync)
FROM node:22-bookworm-slim

# Конвертеры из раздела 6 ТЗ + git для server/sync.js (pull из Obsidian-хранилища) —
# в одном образе (в compose можно вынести в отдельные контейнеры)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress \
    ffmpeg fonts-liberation fonts-dejavu git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/site').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Контейнер работает от root: volume /data при первом старте принадлежит root,
# а приложение должно свободно создавать в нём файлы и бэкапы.
CMD ["node", "server/index.js"]
