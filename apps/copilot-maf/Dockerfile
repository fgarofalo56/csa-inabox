# CSA Loom — MAF orchestration tier (loom-copilot-maf)
# Microsoft Agent Framework Container App for GCC-High / IL5.
# Runs the Copilot agent loop against Gov AOAI direct (*.openai.azure.us).
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist ./dist
EXPOSE 3100
# Non-root for IL5 hardening
USER node
CMD ["node", "dist/index.js"]
