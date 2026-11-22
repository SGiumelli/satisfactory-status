FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
USER node
VOLUME /data
CMD ["node", "src/index.js"]
