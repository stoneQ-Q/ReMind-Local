FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY db/migrations ./migrations
RUN npm run build

FROM node:24-alpine AS runtime-base

ARG REMIND_RELEASE=development
ENV NODE_ENV=production
ENV REMIND_RELEASE=${REMIND_RELEASE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

RUN mkdir -p /var/lib/remind/objects \
  && chown -R node:node /var/lib/remind

USER node
CMD ["node", "dist/api.js"]

FROM runtime-base AS runtime

FROM runtime-base AS worker

USER root
RUN apk add --no-cache ffmpeg
USER node

FROM runtime-base AS backup

USER root
RUN apk add --no-cache postgresql17-client
USER node
