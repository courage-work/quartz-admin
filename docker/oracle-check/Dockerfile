# 사내 Oracle 구버전 점검 이미지 (B-35, docs/oracle-legacy-check.md)
#
#   docker build -f docker/oracle-check/Dockerfile -t quartz-admin-oracle-check:<버전> .
#   docker save quartz-admin-oracle-check:<버전> -o quartz-admin-oracle-check.tar
#
# 인터넷이 되는 PC에서 빌드해 사내망 PC로 옮긴다. 사내 PC에는 Docker만 있으면 된다(Node·pnpm·Maven·저장소 불필요).
# 점검 스크립트(@qa/store check:oracle), JRE, 테스트베드 jar(Quartz 2.3.2·2.5.2)를 함께 담아, 샌드박스 노드를
# 컨테이너가 아니라 이 컨테이너 안의 Java 프로세스로 띄운다. 그래서 Docker 소켓이나 다른 이미지를 쓰지 않는다.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG JRE_IMAGE=eclipse-temurin:17-jre-noble

# ── 테스트베드 jar (tools/quartz-testbed) ──────────────────────
FROM maven:3.9.16-eclipse-temurin-17 AS testbed
WORKDIR /src
COPY tools/quartz-testbed/pom.xml .
RUN mvn -B -q -Dquartz.version=2.3.2 dependency:go-offline \
  && mvn -B -q -Dquartz.version=2.5.2 dependency:go-offline
COPY tools/quartz-testbed/src ./src
# 테스트베드 자체 테스트는 CI의 테스트베드 이미지 빌드에서 돈다
RUN mkdir /out \
  && for v in 2.3.2 2.5.2; do \
       mvn -B -q -DskipTests -Dquartz.version=$v clean package \
       && cp target/quartz-testbed.jar /out/quartz-testbed-$v.jar; \
     done

# ── 점검 스크립트와 의존성 ─────────────────────────────────────
FROM ${NODE_IMAGE} AS build
ENV CI=1
RUN corepack enable
WORKDIR /app
# 워크스페이스 manifest를 모두 둬야 잠금 파일과 맞는다. 설치는 @qa/store와 그 의존성만 한다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/store/package.json packages/store/
RUN pnpm install --frozen-lockfile --filter "@qa/store..."
COPY packages/core packages/core
COPY packages/shared packages/shared
COPY packages/store packages/store
COPY tools/quartz-testbed/schema tools/quartz-testbed/schema
# 점검 스크립트는 @qa/store 소스를 vitest로 바로 돌리고, @qa/shared·@qa/core는 빌드 결과(dist)를 쓴다
RUN pnpm --filter @qa/shared --filter @qa/core build
# 비루트 사용자(--user)로 돌려도 vitest가 캐시를 쓸 수 있게 한다
RUN mkdir -p node_modules/.vitest-cache packages/store/node_modules/.vite \
  && chmod 1777 node_modules/.vitest-cache packages/store/node_modules/.vite

# ── 실행 이미지 ────────────────────────────────────────────────
FROM ${JRE_IMAGE} AS jre
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="quartz-admin-oracle-check" \
      org.opencontainers.image.description="quartz-admin 사내 Oracle 구버전 점검 (B-35)" \
      org.opencontainers.image.source="https://github.com/courage-work/quartz-admin" \
      org.opencontainers.image.licenses="MIT"
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:$PATH \
    QA_CHECK_TARGET=/check/target.json \
    QA_CHECK_REPORT_DIR=/check/results \
    QA_CHECK_TESTBED_JAR_DIR=/opt/testbed
COPY --from=build /app /app
COPY --from=testbed /out /opt/testbed
COPY docker/oracle-check/entrypoint.sh /usr/local/bin/qa-oracle-check
RUN chmod 755 /usr/local/bin/qa-oracle-check
WORKDIR /app/packages/store
ENTRYPOINT ["qa-oracle-check"]
