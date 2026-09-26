FROM node:22-bookworm-slim

# better-sqlite3 needs build tools to compile its native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Persistent data (SQLite database + uploaded documents) lives in /data
RUN mkdir -p /data
ENV DB_PATH=/data/saroye.db \
    UPLOAD_DIR=/data/uploads \
    PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
