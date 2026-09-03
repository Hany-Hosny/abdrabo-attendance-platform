FROM node:22-alpine

ENV NODE_ENV=production
ENV HOME=/tmp
ENV NPM_CONFIG_CACHE=/tmp/.npm

RUN addgroup -S -g 10001 appgroup \
    && adduser -S -D -H \
      -u 10001 \
      -G appgroup \
      -s /sbin/nologin \
      appuser

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json

RUN npm ci \
    --omit=dev \
    --workspace=@abdrabo/backend \
    --include-workspace-root=false \
    && npm cache clean --force

COPY --chown=appuser:appgroup backend/src ./backend/src

RUN mkdir -p /app/backend/whatsapp_auth \
    && chown appuser:appgroup /app/backend/whatsapp_auth

WORKDIR /app/backend

USER appuser

EXPOSE 4000

CMD ["npm", "start"]
