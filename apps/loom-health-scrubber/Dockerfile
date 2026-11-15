# Image for the LHDS PHI log scrubber (apps/loom-health-scrubber) - LHDS W2-5.
#
# BUILD CONTEXT IS THE APP DIRECTORY:
#
#   docker build -t loom-health-scrubber apps/loom-health-scrubber
#
# The program has no dependencies, so there is no install step and nothing is downloaded.
# It reads log lines on stdin and writes scrubbed lines on stdout:
#
#   <engine log stream> | docker run -i --rm loom-health-scrubber
#
# How it is wired next to the engine on a stamp is NOT done here (see README "Not covered").
FROM node:22-slim

WORKDIR /app
COPY package.json ./
COPY src ./src

USER node
ENTRYPOINT ["node", "/app/src/cli.mjs"]
