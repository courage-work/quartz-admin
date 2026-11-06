# quartz-admin 실행 이미지 (TRD §11.1)
#
#   docker build -f docker/Dockerfile -t quartz-admin .
#   docker compose -f docker/compose.yaml up -d
#
# 빌드 단계에서 웹(정적 export)과 API를 빌드하고, 실행 이미지에는 운영 의존성과 결과물만 옮긴다.
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
# better-sqlite3는 사전 빌드 바이너리를 받지 못하면 소스로 빌드한다
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable
WORKDIR /src

# 잠금 파일만 먼저 복사해 의존성을 받는다. 소스만 바뀌면 이 레이어를 다시 쓴다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --frozen-lockfile --offline
# @qa/api 빌드는 웹 빌드 뒤에 결과물을 apps/api/public으로 복사한다 (turbo.json)
RUN pnpm turbo run build --filter=@qa/api
# 운영 의존성과 @qa/api의 files(dist, drizzle, public)만 /out에 모은다
RUN pnpm --filter @qa/api deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="quartz-admin" \
      org.opencontainers.image.description="Quartz Scheduler 클러스터 관리 도구" \
      org.opencontainers.image.source="https://github.com/courage-work/quartz-admin" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    QA_DATA_DIR=/data \
    PORT=3000
WORKDIR /app
# 앱 파일은 root 소유로 두어 실행 사용자(node)가 고칠 수 없게 한다. 쓰기는 /data만 (NFR-SEC-05)
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
