FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=8080
RUN apk add --no-cache curl
WORKDIR /app

COPY --chown=node:node . .

USER node
EXPOSE 8080
CMD ["node", "server.js"]
