FROM node:22-alpine
# eMudhra CA distrust (Oct 2026): current CA bundle, and make Node trust it instead of its bundled root list
RUN apk add --no-cache --upgrade ca-certificates-bundle
ENV NODE_OPTIONS="--use-openssl-ca"

ENV NODE_ENV=production
ENV PORT=8080
RUN apk add --no-cache curl
WORKDIR /app

COPY --chown=node:node . .

USER node
EXPOSE 8080
CMD ["node", "server.js"]
