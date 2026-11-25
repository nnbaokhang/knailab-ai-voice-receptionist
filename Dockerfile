FROM node:24-alpine
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--experimental-strip-types", "src/index.ts"]
