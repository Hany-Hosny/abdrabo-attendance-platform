FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

COPY package*.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
COPY shared/package.json ./shared/package.json
RUN npm ci

COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/public ./frontend/public
COPY shared ./shared
RUN npm run build --workspace frontend

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
