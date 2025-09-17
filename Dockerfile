FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libnss3 \
  libx11-xcb1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .

RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
