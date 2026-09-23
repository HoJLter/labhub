# lab-hub — продакшн-образ: Node 22 + ffmpeg (постеры видео) + git (Obsidian Git sync)
# Конвертация DOCX→PDF удалена — LibreOffice в образе не нужен (~1.2 ГБ экономии).
# База Alpine вместо bookworm: то же наполнение, но слои дистрибутива заметно меньше.
FROM node:22-alpine

# ffmpeg для постеров/длительности видео + git для server/sync.js (pull из Obsidian-хранилища).
# node:sqlite — часть официальных сборок Node (в т.ч. musl-сборки alpine-образа).
RUN apk add --no-cache \
    ffmpeg \
    git

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
