# Build the static Cockpit and serve it with nginx, which also proxies /api/ to needforheat-server-api.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# The official nginx image runs envsubst on /etc/nginx/templates/*.template at start-up.
ENV API_UPSTREAM=http://api:8080 KLUIS_URL=https://kluis.energiegedrag.nl/
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
