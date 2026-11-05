# quartz-testbed: Quartz JDBC JobStore 클러스터 노드 + cron 벡터 생성기
#
#   docker build -t quartz-testbed:2.3.2 tools/quartz-testbed
#   docker build --build-arg QUARTZ_VERSION=2.5.2 -t quartz-testbed:2.5.2 tools/quartz-testbed
#
# 빌드 단계에서 JUnit 테스트를 함께 돌린다. 베이스 이미지는 amd64와 arm64를 모두 제공한다.
ARG QUARTZ_VERSION=2.3.2

FROM maven:3.9.16-eclipse-temurin-17 AS build
ARG QUARTZ_VERSION
WORKDIR /src
# 의존성 레이어를 먼저 만들어 소스만 바뀔 때는 다시 내려받지 않는다
COPY pom.xml .
RUN mvn -B -q -Dquartz.version=${QUARTZ_VERSION} dependency:go-offline
COPY src ./src
RUN mvn -B -Dquartz.version=${QUARTZ_VERSION} package

FROM eclipse-temurin:17-jre-noble
ARG QUARTZ_VERSION
LABEL org.opencontainers.image.title="quartz-testbed" \
      org.opencontainers.image.description="quartz-admin 통합 테스트용 Quartz ${QUARTZ_VERSION} 클러스터 노드"
ENV QUARTZ_VERSION=${QUARTZ_VERSION}
WORKDIR /app
COPY --from=build /src/target/quartz-testbed.jar /app/quartz-testbed.jar
EXPOSE 8080
ENTRYPOINT ["java", "-XX:+ExitOnOutOfMemoryError", "-jar", "/app/quartz-testbed.jar"]
CMD ["server"]
