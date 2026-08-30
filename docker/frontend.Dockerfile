# -----------------------------------------------------------------------------
# AYROVI Warehouse Core — Frontend (React + Vite) — Production build image
# Builds a static bundle, then serves it with nginx.
# -----------------------------------------------------------------------------

FROM node:20-alpine AS builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# VITE_API_BASE should be the absolute API URL in production, e.g. /api (behind
# the same origin / reverse proxy) or https://api.warehouse.ayrovi.com.
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

FROM nginx:alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
