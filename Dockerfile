# Small, non-root image. Node runs the TypeScript sources directly (no build step).
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY tsconfig.json ./

# Database lives in a volume so it survives image updates.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
USER node

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
