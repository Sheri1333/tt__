FROM node:22-slim
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm test
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/funnel.db
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
