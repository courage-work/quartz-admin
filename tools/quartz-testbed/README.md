# quartz-testbed

quartz-admin 통합 테스트용 Quartz 노드입니다(TRD §12.1). 실제 Quartz JDBC JobStore 클러스터를 띄워 도구의 제어 결과를 "실제로 발화했는지"로 검증하고, Quartz `Scheduler` API로 차등 테스트의 기준값을 만들고, cron 이식본의 검증 벡터를 생성합니다.

- Java 17, Quartz 2.3.2(기본) 또는 2.5.x(빌드 인자)
- JDBC JobStore(`JobStoreTX`) 클러스터 모드, HikariCP
- Oracle(ojdbc11)과 PostgreSQL(postgresql 42.7.7) 드라이버를 넣었습니다. MySQL, MariaDB 드라이버는 B-28~B-29에서 추가합니다.

## 빌드

Java나 Maven을 설치하지 않아도 Docker로 빌드할 수 있습니다. 빌드 단계에서 JUnit 테스트도 함께 돕니다.

```bash
docker build -t quartz-testbed:2.3.2 tools/quartz-testbed
docker build --build-arg QUARTZ_VERSION=2.5.2 -t quartz-testbed:2.5.2 tools/quartz-testbed
```

베이스 이미지(`maven`, `eclipse-temurin`)는 amd64와 arm64를 모두 제공하므로 Apple Silicon에서도 에뮬레이션 없이 돕니다.

## 명령

| 명령                                    | 설명                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `server` (기본)                         | 클러스터 노드로 기동하고 `:8080`에서 제어 API를 엽니다                 |
| `cron-vectors [--input F] [--output F]` | cron 다음 실행 시각 벡터를 만듭니다. 기본은 stdin → stdout             |
| `core-vectors [--input F] [--output F]` | `@qa/core` 이식 검증 벡터를 만듭니다(cron, 트리거, 타임존, properties) |
| `version`                               | Quartz 버전을 출력합니다                                               |

## 환경변수 (`server`)

| 변수                                     | 기본값               | 설명                                                                              |
| ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `TESTBED_DB_URL`                         | (필수)               | JDBC URL. 예: `jdbc:oracle:thin:@//oracle:1521/FREEPDB1`                          |
| `TESTBED_DB_USER`, `TESTBED_DB_PASSWORD` | (필수)               | DB 계정                                                                           |
| `TESTBED_SCHEDULER_NAME`                 | `TestbedScheduler`   | `SCHED_NAME` (`org.quartz.scheduler.instanceName`)                                |
| `TESTBED_INSTANCE_ID`                    | `AUTO`               | 노드 인스턴스 ID                                                                  |
| `TESTBED_TABLE_PREFIX`                   | `QRTZ_`              | `org.quartz.jobStore.tablePrefix`                                                 |
| `TESTBED_DRIVER_DELEGATE`                | URL로 판단           | Oracle `OracleDelegate`, PostgreSQL `PostgreSQLDelegate`, 그 외 `StdJDBCDelegate` |
| `TESTBED_THREAD_COUNT`                   | `5`                  | 작업 스레드 수                                                                    |
| `TESTBED_CLUSTER_CHECKIN_INTERVAL_MS`    | `7500`               | 클러스터 체크인 간격(Quartz 기본값과 같음)                                        |
| `TESTBED_MISFIRE_THRESHOLD_MS`           | `60000`              | misfire 판정 기준                                                                 |
| `TESTBED_MAX_CONNECTIONS`                | 스레드 수 + 3        | Quartz 커넥션 풀 크기                                                             |
| `TESTBED_HTTP_PORT`                      | `8080`               | 제어 API 포트                                                                     |
| `TESTBED_EXECUTIONS_TABLE`               | `TESTBED_EXECUTIONS` | 실행 기록 테이블                                                                  |
| `TESTBED_DB_PROPERTIES`                  |                      | JDBC 드라이버 속성(properties 형식, 줄 단위)                                      |
| `TESTBED_QUARTZ_PROPERTIES`              |                      | 덮어쓸 Quartz 설정(properties 형식, 줄 단위)                                      |
| `TESTBED_START`                          | `true`               | `false`면 `start()`하지 않는 기준 인스턴스(차등 테스트)                           |

Oracle이면 `oracle.jdbc.sendBooleanAsNativeBoolean=false`를 기본으로 넣습니다. ojdbc 23은 Oracle 23에 접속하면 불리언을 네이티브 BOOLEAN으로 보내는데, Quartz 기본 스키마(`tables_oracle.sql`)의 불리언 컬럼은 `VARCHAR2(1)`이라 `ORA-12899`로 실패합니다. false로 두면 이전 드라이버처럼 1/0을 보내 운영(19c 이하)과 같은 `'1'`/`'0'`이 저장됩니다. 2.5.x의 `tables_oracle23.sql`(BOOLEAN 컬럼)을 쓸 때는 `TESTBED_DB_PROPERTIES=oracle.jdbc.sendBooleanAsNativeBoolean=true`로 바꿉니다.

## 테스트 잡

| 잡                      | 동작                                     | JobDataMap                  |
| ----------------------- | ---------------------------------------- | --------------------------- |
| `RecordingJob`          | 실행 기록만 남기고 끝남                  |                             |
| `NonConcurrentSleepJob` | `@DisallowConcurrentExecution`, N초 실행 | `sleepSeconds`(기본 5)      |
| `LongJob`               | 오래 실행, `/control/interrupt`로 중단   | `durationSeconds`(기본 600) |

세 잡 모두 시작할 때 `TESTBED_EXECUTIONS`에 행을 넣고(`OUTCOME=RUNNING`), 끝날 때 `FINISHED_AT`과 `OUTCOME`(`OK`, `INTERRUPTED`, `ERROR`)을 채웁니다. 테이블이 없으면 노드가 기동할 때 만듭니다.

| 컬럼                                                            | 내용                                 |
| --------------------------------------------------------------- | ------------------------------------ |
| `FIRE_INSTANCE_ID` (PK)                                         | Quartz fire instance ID              |
| `SCHED_NAME`, `INSTANCE_ID`                                     | 실행한 스케줄러와 노드               |
| `JOB_NAME`, `JOB_GROUP`, `JOB_CLASS`                            | 잡                                   |
| `TRIGGER_NAME`, `TRIGGER_GROUP`                                 | 발화한 트리거                        |
| `SCHEDULED_FIRE_TIME`, `FIRE_TIME`, `STARTED_AT`, `FINISHED_AT` | epoch ms                             |
| `OUTCOME`, `RECOVERING`(`1`/`0`), `REFIRE_COUNT`                | 실행 결과                            |
| `JOB_DATA`                                                      | 잡과 트리거의 JobDataMap을 합친 JSON |

## 제어 API

같은 이름의 Quartz `Scheduler` 메서드를 그대로 호출합니다. 쓰기는 `POST /control/<메서드>`에 JSON 본문, 읽기는 `GET`에 쿼리 파라미터를 씁니다. 성공하면 `{"result": ...}`, 실패하면 `{"error": "...", "message": "..."}`(400 입력 오류, 409 이미 있음, 500 Quartz 오류)를 돌려줍니다. 키는 `{"name", "group"}`이고 group을 빼면 `DEFAULT`입니다.

| 메서드 | 경로                                                                  | 본문 / 쿼리                                                                                                |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`                                                            | 스케줄러가 기동했으면 200, 아니면 503                                                                      |
| GET    | `/control/metadata`                                                   | 스케줄러 이름, 인스턴스 ID, Quartz 버전, 상태                                                              |
| GET    | `/control/triggerState`                                               | `?name=&group=`                                                                                            |
| GET    | `/control/trigger`, `/control/job`                                    | `?name=&group=`                                                                                            |
| GET    | `/control/pausedTriggerGroups`                                        |                                                                                                            |
| GET    | `/control/currentlyExecutingJobs`                                     | 이 노드에서 실행 중인 잡                                                                                   |
| POST   | `/control/scheduleJob`                                                | `{"job": 잡, "trigger": 트리거, "replace": false}`. job 없이 `trigger.forJob`을 주면 기존 잡에 트리거 추가 |
| POST   | `/control/addJob`                                                     | `{"job": 잡, "replace": false}` (durable 잡)                                                               |
| POST   | `/control/pauseTrigger`, `resumeTrigger`                              | 트리거 키                                                                                                  |
| POST   | `/control/pauseJob`, `resumeJob`                                      | 잡 키                                                                                                      |
| POST   | `/control/pauseTriggers`, `resumeTriggers`, `pauseJobs`, `resumeJobs` | `{"group", "operator"}`. operator는 `EQUALS`(기본), `STARTS_WITH`, `ENDS_WITH`, `CONTAINS`, `ANYTHING`     |
| POST   | `/control/pauseAll`, `resumeAll`                                      |                                                                                                            |
| POST   | `/control/triggerJob`                                                 | 잡 키 + `data`(선택)                                                                                       |
| POST   | `/control/rescheduleJob`                                              | 기존 트리거 키 + `trigger`(새 트리거)                                                                      |
| POST   | `/control/unscheduleJob`                                              | 트리거 키                                                                                                  |
| POST   | `/control/deleteJob`                                                  | 잡 키                                                                                                      |
| POST   | `/control/interrupt`                                                  | 잡 키                                                                                                      |

### 차등 테스트 도구

Quartz API가 아니라 DB를 직접 다룹니다(TRD §12.1, 부록 A.1). Quartz와 같은 커넥션 풀을 쓰고 JDBC 표준 문법만 씁니다. `schedName`을 빼면 이 노드의 `SCHED_NAME`입니다.

| 메서드 | 경로                | 본문 / 쿼리                                                                                                                                  |
| ------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/fixture/sql`      | `{"statements": ["UPDATE …", "INSERT …"]}`. 한 트랜잭션으로 실행하고 문장별 바뀐 행 수를 돌려줌. API로 만들 수 없는 초기 상태(ACQUIRED 등)용 |
| POST   | `/fixture/holdLock` | `{"seconds": 10, "lockName": "TRIGGER_ACCESS", "schedName"}`. 잠금 행을 잡은 뒤 응답하고, 시간이 지나면 ROLLBACK                             |
| GET    | `/fixture/snapshot` | `?schedName=`. Quartz 테이블별 행(SCHED_NAME 컬럼 제외, 행은 JSON 문자열 순). 이름이 다른 두 스케줄러의 결과를 바로 비교                     |

`TESTBED_START=false`로 띄운 기준 인스턴스는 `start()`하지 않으므로 트리거 획득, misfire 처리, 클러스터 체크인이 돌지 않습니다. Quartz API 결과 행이 결정적이라 차등 테스트의 기준값을 만듭니다. 클러스터 노드와 같은 `SCHED_NAME`을 쓰지 않습니다(클러스터가 그 트리거를 발화시킴). `/healthz`는 스케줄러가 만들어지면 200입니다.

잡 명세:

```json
{
  "name": "rec",
  "group": "g",
  "type": "RecordingJob",
  "durable": false,
  "requestsRecovery": false,
  "data": { "k": "v" }
}
```

트리거 명세(`type`은 `simple` 또는 `cron`, `startAt`/`endAt`은 epoch ms, `misfire`는 Quartz 상수 이름이며 `MISFIRE_INSTRUCTION_` 접두어는 생략 가능):

```json
{
  "name": "t",
  "group": "g",
  "type": "simple",
  "intervalMs": 1000,
  "repeatCount": -1,
  "priority": 5,
  "misfire": "FIRE_NOW"
}
```

```json
{
  "name": "c",
  "group": "g",
  "type": "cron",
  "cron": "0/5 * * * * ?",
  "timeZone": "Asia/Seoul",
  "misfire": "DO_NOTHING"
}
```

## cron-vectors

```bash
docker run -i --rm quartz-testbed:2.3.2 cron-vectors < cases.json > vectors.json
```

입력:

```json
{
  "count": 20,
  "cases": [
    {
      "id": "dst-ny",
      "cron": "0 30 2 * * ?",
      "timeZone": "America/New_York",
      "from": ["2026-03-07T12:00:00Z", 1772928000000]
    }
  ]
}
```

(case, from) 조합마다 결과를 하나씩 냅니다. `next`는 epoch ms, `nextLocal`은 그 타임존의 ISO-8601 문자열입니다. 표현식이 잘못되면 case마다 `error`에 Quartz 오류 메시지를 담습니다. Java는 모르는 타임존 ID를 조용히 `GMT`로 바꾸므로 실제로 쓴 ID를 `resolvedTimeZone`에 남깁니다. 파싱은 되지만 계산 중 예외가 나는 표현식(2.3.2의 `L * * * * ?` 등)은 `runtimeError`에 예외 이름을 남깁니다.

## core-vectors

`@qa/core` 이식본(TRD §6)의 기준값을 만듭니다. 보통은 직접 쓰지 않고 `pnpm --filter @qa/core vectors`가 2.3.2, 2.5.2 이미지로 실행해 `packages/core/test/vectors/quartz.json`을 만듭니다.

| 입력 절          | 결과                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `cron`           | `cron-vectors`와 같음                                                                                           |
| `cronTriggers`   | `CronTriggerImpl`: 밀리초를 버린 시작 시각, `computeFirstFireTime` 이후 시각 목록, `after`별 `getFireTimeAfter` |
| `simpleTriggers` | `SimpleTriggerImpl`: 같은 형식. 값이 잘못되면 `error`                                                           |
| `timeZones`      | `TimeZone.getTimeZone(id)`가 쓰는 ID, `ZoneId`, 시점별 오프셋                                                   |
| `allTimeZonesAt` | `TimeZone.getAvailableIDs()` 전체에 대해 위와 같은 결과(`allTimeZones`)                                         |
| `properties`     | `Properties.load()`(ISO-8859-1) 결과. 잘못된 `\uXXXX`는 `error`                                                 |

결과에는 입력 값을 그대로 담아 결과 파일만으로 비교할 수 있게 합니다.

## 스키마

`schema/`의 SQL은 Quartz 2.5.2 jar의 `org/quartz/impl/jdbcjobstore/`에서 그대로 가져왔습니다(Apache License 2.0).

| 파일                  | 내용                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `tables_oracle.sql`   | 기본 Oracle 스키마. 2.3.2와 주석 오타 하나만 다름. 불리언은 `VARCHAR2(1)`                           |
| `tables_oracle23.sql` | 2.5.x에 추가된 Oracle 23 스키마. 불리언 컬럼이 `BOOLEAN`                                            |
| `tables_postgres.sql` | PostgreSQL 스키마(2.3.2와 같음). 불리언은 `BOOL`, BLOB은 `BYTEA`, 이름은 따옴표 없음(소문자로 저장) |

통합 테스트 헬퍼(`packages/store/test/support/quartz-schema.ts`)가 이 파일에서 CREATE 문만 골라 prefix와 대소문자를 바꿔 실행합니다.

## 통합 테스트에서 쓰기

`packages/store/test/support/`의 헬퍼가 DB 컨테이너(Oracle Free 23 또는 PostgreSQL), 스키마 초기화, 테스트베드 노드 기동, 실행 기록 조회를 맡습니다.

```bash
pnpm test:integration                                   # Docker 필요. 테스트베드 이미지를 직접 빌드
QA_IT_QUARTZ_VERSION=2.5.2 pnpm test:integration        # Quartz 2.5.2로
QA_IT_TESTBED_IMAGE=quartz-testbed:2.3.2 pnpm test:integration  # 미리 빌드한 이미지 사용
QA_IT_LOGS=1 pnpm test:integration                      # 노드 로그를 stderr로
QA_IT_DB=postgres pnpm test:integration                 # PostgreSQL 17로
QA_IT_DB=postgres QA_IT_POSTGRES_VERSION=11 pnpm test:integration  # PostgreSQL 11로
```

| 변수                     | 기본값                                 | 설명                                                                  |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| `QA_IT_QUARTZ_VERSION`   | `2.3.2`                                | 테스트베드 Quartz 버전                                                |
| `QA_IT_TESTBED_IMAGE`    |                                        | 미리 빌드한 이미지. 없으면 `quartz-admin-testbed:<버전>-local`로 빌드 |
| `QA_IT_ORACLE_IMAGE`     | `gvenzl/oracle-free:23-slim-faststart` | Oracle 이미지(amd64, arm64)                                           |
| `QA_IT_LOGS`             |                                        | `1`이면 노드 로그 출력                                                |
| `QA_IT_DB`               | `oracle`                               | 통합 테스트 DB. `postgres`면 PostgreSQL                               |
| `QA_IT_POSTGRES_VERSION` | `17`                                   | PostgreSQL 버전(이미지 `postgres:<버전>-alpine`)                      |
| `QA_IT_POSTGRES_IMAGE`   |                                        | PostgreSQL 이미지를 직접 지정                                         |
