FROM node:20-slim

WORKDIR /app

# SQLite 컴파일용 필수 도구 설치
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# 데이터 및 로그 저장용 폴더 생성
RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
