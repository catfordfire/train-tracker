FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src

# API URL empty = nginx proxies /api internally (recommended)
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

ARG VITE_STADIA_API_KEY=""
ENV VITE_STADIA_API_KEY=$VITE_STADIA_API_KEY

RUN npm run build

# ── Serve with nginx ──
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
