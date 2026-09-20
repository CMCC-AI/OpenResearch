FROM node:22-bookworm-slim
WORKDIR /app/platform
COPY packages/platform/package.json packages/platform/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY packages/platform/src ./src
COPY packages/platform/migrations ./migrations
COPY packages/platform/public ./public
COPY ui/dist /app/ui/dist
COPY LICENSE /usr/share/doc/openresearch/LICENSE
USER node
EXPOSE 5300
CMD ["node", "src/server.mjs"]
