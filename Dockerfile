# SPDX-License-Identifier: EUPL-1.2
# Build the static Cockpit and serve it with nginx, which also proxies /api/ to needforheat-server-api.
# The static build is the same for every platform: run it natively. Debian (glibc), not Alpine: Rollup's musl
# binary fails on this project with "Code is nested too deeply"; the CI build on Ubuntu works.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

FROM nginx:1.30.7-alpine
# The official nginx image runs envsubst on /etc/nginx/templates/*.template at start-up.
ENV API_UPSTREAM=http://api:8080 KLUIS_URL=https://kluis.energiegedrag.nl/ MIRROR_UPSTREAM=http://firmware-mirror:8090
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
