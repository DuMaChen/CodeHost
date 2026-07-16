FROM node:22-bookworm-slim

WORKDIR /platform
COPY server.mjs /platform/server.mjs
USER 1000:1000
EXPOSE 8080
CMD ["node", "/platform/server.mjs"]
