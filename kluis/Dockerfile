# Local vault (docs/23): build the static files reproducibly, then serve them with nginx next to the API proxy.
# Build from the repository root so maak.py sees the git commit (kluis/Dockerfile.dockerignore keeps .git;
# for a git URL context BuildKit also needs BUILDKIT_CONTEXT_KEEP_GIT_DIR=1):
#   docker build -f kluis/Dockerfile --build-arg BUILDKIT_CONTEXT_KEEP_GIT_DIR=1 .
FROM python:3.13-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN git config --global --add safe.directory /src && python kluis/maak.py --uit /dist

FROM nginx:1.27-alpine
COPY kluis/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /dist /usr/share/nginx/html
ENV API_UPSTREAM=http://api:8080
