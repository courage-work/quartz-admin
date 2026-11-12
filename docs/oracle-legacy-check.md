# 사내 Oracle 구버전 점검 안내 (B-35)

Oracle 12.1, 18c, 19c는 공식 컨테이너가 없어 CI에서 검증하지 못합니다(TRD §5.1). 출시 전에 사내 19c(가능하면 12c) 인스턴스로 이 문서의 점검표를 수행합니다. 대부분은 점검 스크립트가 자동으로 확인하고, 화면 흐름 몇 가지만 손으로 봅니다.

## 1. 준비

**점검을 돌리는 PC**(사내망에서 대상 DB에 접속할 수 있어야 함)

- Node 24, pnpm, 이 저장소(`pnpm install`이 npm 레지스트리나 사내 미러에 접근할 수 있어야 합니다)
- 샌드박스 점검(제어·알림)을 하려면 Docker도 필요합니다. 테스트베드 노드(Quartz)를 컨테이너로 띄워 대상 DB에 붙입니다.
  - Docker 컨테이너에서 대상 DB 호스트·포트로 접속할 수 있어야 합니다.
  - 테스트베드 이미지는 처음 실행할 때 Maven으로 빌드합니다(인터넷 필요). 사내망에 인터넷이 없으면 인터넷이 되는 PC에서 만든 이미지를 옮깁니다.

    ```bash
    docker save quartz-admin-testbed:2.3.2-local -o testbed-2.3.2.tar
    ```

    ```bash
    docker load -i testbed-2.3.2.tar
    ```

    그리고 `QA_IT_TESTBED_IMAGE=quartz-admin-testbed:2.3.2-local`로 실행합니다.

**대상 DB 계정**

| 점검 | 필요한 것 |
| --- | --- |
| 읽기 점검(1·3·4단계) | 기존 Quartz 테이블의 SELECT 권한. 다른 스키마의 테이블이면 설정의 `schema`에 소유자를 적습니다. 운영 도구에 쓸 읽기 계정과 같은 권한이면 됩니다 |
| 샌드박스 점검(2·5·6단계) | 접속 계정에 `CREATE TABLE`과 기본 테이블스페이스 할당량. 같은 계정에 `QACHK_` 테이블 12개를 만들고 끝나면 지웁니다. 기존 테이블은 건드리지 않습니다 |

읽기 점검은 SELECT만 실행합니다. 샌드박스 점검의 쓰기도 `QACHK_` 테이블에만 합니다. 인증 실패 분류는 계정 잠금(`FAILED_LOGIN_ATTEMPTS`)을 피하려고 틀린 비밀번호 대신 없는 계정(`QA_CHECK_NO_SUCH_USER`)으로 한 번 시도합니다.

## 2. 실행

`packages/store/.check-target.json`(git 제외)을 만듭니다. 비밀번호가 들어가므로 점검이 끝나면 지웁니다.

```json
{
  "host": "db19.example.internal",
  "port": 1521,
  "serviceName": "QUARTZPDB",
  "username": "quartz_check",
  "password": "********",
  "schema": "QUARTZ",
  "schedulers": ["BatchScheduler"],
  "sandbox": true,
  "quartzVersion": "2.3.2"
}
```

| 키 | 필수 | 설명 |
| --- | --- | --- |
| `host`, `port`, `username`, `password` | 예 | 접속 정보 |
| `serviceName` / `sid` | 둘 중 하나 | Oracle 서비스 이름 또는 SID |
| `schema` | | Quartz 테이블 소유 스키마. 비우면 접속 계정 |
| `schedulers` | | 읽기 점검할 SCHED_NAME. 비우면 감지한 후보 전부(최대 6개) |
| `sandbox` | | `true`면 제어·알림까지 점검(Docker 필요). 기본 `false` |
| `sandboxPrefix` | | 샌드박스 테이블 prefix. 기본 `QACHK_`. 이미 있으면 샌드박스를 건너뜁니다 |
| `jdbcHost` | | 테스트베드 컨테이너가 DB에 붙을 호스트. 기본 `host`(`localhost`면 `host.docker.internal`) |
| `quartzVersion` | | 테스트베드 Quartz 버전. 기본 `2.3.2` |

```bash
pnpm --filter @qa/store check:oracle
```

결과는 레포 루트 `check-results/oracle-<시각>.md`(git 제외)에 남습니다. 실패한 항목이 있으면 명령이 실패로 끝납니다. 보고서에는 호스트·계정·비밀번호가 들어가지 않으니(스키마와 SCHED_NAME은 들어감) 그대로 공유하면 됩니다. 설정 파일이 없으면 로컬 Oracle 컨테이너(Free 23, `QA_IT_ORACLE_VERSION=21`이면 XE 21)로 같은 점검을 돌립니다(도구 자체 검증용).

## 3. 점검표

**자동**(점검 스크립트)

| ID | 단계 | 항목 | 통과 기준 |
| --- | --- | --- | --- |
| L-01 | 1 | 제품 어댑터 접속 | oracledb Thin 모드로 접속(Instant Client 없이) |
| L-02 | 1 | DB 버전·문자셋 | 보고서에 기록(판정 없음) |
| L-03 | 1 | 시계 차이 | 도구 PC와 DB 시각 차이 30초 미만 |
| L-04 | 1 | 인증 실패 분류 | 없는 계정이 `TARGET_AUTH_FAILED`(ORA-01017)이고 오류에 호스트·계정이 없음 |
| L-05 | 2 | 샌드박스 스키마 | `tables_oracle.sql`로 `QACHK_` 테이블 생성 |
| L-06 | 2 | 테스트베드 노드 | Quartz 노드 2개가 체크인, 기준 인스턴스(시작 안 함) 기동 |
| L-07 | 3 | 자동 감지 | 테이블 세트, 선택 컬럼, 불리언 형식, 쓰기 권한, SCHED_NAME 후보. 샌드박스는 쓰기 가능·`10` 형식 |
| L-08 | 4 | 감시 1회 | 상태별 개수, 노드, 연체(`OFFSET … FETCH`), ERROR·BLOCKED, 실행 중 |
| L-09 | 4 | 트리거 목록 | 키·다음 실행 정렬, 마지막 쪽, 상태 필터, 200개, `%`·`_`·`'` 검색(`ESCAPE`) |
| L-10 | 4 | 잡 목록과 상세 | 목록·마지막 쪽·검색, 트리거·잡 상세(JobDataMap BLOB) |
| L-11 | 4 | 그 밖의 조회 | 노드, 실행 중, 일시정지 그룹, 그룹 선택지 |
| L-12 | 5 | 일시정지·재개 | 트리거, 잡, 트리거 그룹(`PAUSED_TRIGGER_GRPS`), 잡 그룹 |
| L-13 | 5 | 즉시 실행 | 노드가 60초 안에 실제로 실행 |
| L-14 | 5 | 스케줄 수정 | CRON 식·타임존, SIMPLE 간격·횟수 |
| L-15 | 5 | 삭제 | 트리거 삭제(마지막 트리거면 durable이 아닌 잡도), 잡 삭제 |
| L-16 | 5 | 잠금 | 명령 뒤 `TRIGGER_ACCESS`가 풀려 있음(`FOR UPDATE WAIT`) |
| L-17 | 6 | 알림 판정 | TRIGGER_ERROR, OVERDUE, NODE_MISSING, CLUSTER_DOWN이 실제 수집 값으로 발생 |
| L-18 | 7 | 정리 | 샌드박스 테이블과 실행 기록 테이블 삭제 |

**수동**(도구 화면, 사내 19c에서 한 번)

도구를 띄우고(`docker compose` 또는 `pnpm dev:hmr`) 사내 19c의 테스트 스케줄러로 확인합니다.

| ID | 항목 | 통과 기준 |
| --- | --- | --- |
| L-21 | 연결 테스트 | 성공. 틀린 비밀번호는 "인증 실패"로 구분해 보임(계정 잠금 정책에 주의해 한 번만) |
| L-22 | 감지와 등록 | 후보 목록에 테스트 스케줄러, 잡·트리거·노드 수가 실제와 같음 |
| L-23 | 대시보드와 상세 | 15초 안에 카드가 채워지고 노드·트리거 수가 맞음. 한글 잡 이름·설명이 깨지지 않음 |
| L-24 | 명령 대화상자 | 테스트 트리거 하나를 일시정지했다가 재개. 미리보기의 대상이 맞고, 실행 결과와 감사 로그가 남음 |
| L-25 | 알림 센터 | 테스트 스케줄러에 기본 알림 규칙이 붙고, 정상 상태면 열린 알림이 없음. 노드를 하나 멈추면 다음 감시 회차(60초 안)에 노드 부족 알림이 뜨고, 다시 띄우면 해소됨(멈출 수 있는 테스트 스케줄러일 때만) |

수동 점검이 끝나면 테스트 트리거와 노드를 원래 상태로 돌려놓았는지 확인합니다.

## 4. 결과 처리

- 모두 통과하면 BACKLOG의 B-35를 `완료`로 바꾸고, TRD §5.1에 점검한 버전과 날짜를 적습니다.
- 실패한 항목은 보고서의 비고(오류 코드·ORA 번호)로 원인을 찾아 고치거나, 고치지 못하면 TRD §5.1에 지원 범위 제외로 적습니다.
