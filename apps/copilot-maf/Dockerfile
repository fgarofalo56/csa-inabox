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
# B-SC1' (loom-apex): drop the bundled npm/npx from the RUNTIME layer. The MAF
# tier runs `node dist/index.js` and never shells out to a package manager.
# npm vendors its own node-tar (node 22.23.1 -> npm 10.9.8 -> tar 7.5.11),
# which the Trivy CRITICAL gate flagged as CVE-2026-59873 (gzip-bomb DoS, fixed
# in tar >= 7.5.19). No node base image bundles a patched npm yet, so the fix
# is to remove the unused package manager rather than suppress the finding.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /root/.npm
COPY --from=builder /app/dist ./dist
EXPOSE 3100
# Non-root for IL5 hardening
USER node
CMD ["node", "dist/index.js"]
