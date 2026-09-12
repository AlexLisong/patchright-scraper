FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx patchright install --with-deps chromium \
    && apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R node:node /app /ms-playwright
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=8787 HEADLESS=false
EXPOSE 8787
CMD ["xvfb-run", "-a", "node", "src/server.mjs"]
