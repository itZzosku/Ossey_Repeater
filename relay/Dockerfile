FROM node:20-slim

WORKDIR /app

# Install production deps only, and skip optional media libs (sharp) — text-only
# mode never touches them, so this keeps the image small and build-tool-free.
COPY package.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

COPY index.js ./

ENV NODE_ENV=production
CMD ["node", "index.js"]
