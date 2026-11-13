# 대상 DB 접속 계정 만들기

quartz-admin이 대상 DB(Quartz 테이블이 있는 DB)에 접속할 계정을 만드는 방법입니다. Quartz 애플리케이션이 쓰는 계정을 그대로 넣지 말고, 이 도구 전용 계정을 따로 만드세요. 권한을 필요한 만큼만 주고, 감사할 때 도구가 한 일을 DB 쪽에서도 구분할 수 있습니다.

## 어떤 계정을 만들까

| 계정 | 할 수 있는 일 | 언제 |
| --- | --- | --- |
| 읽기 전용(`qa_reader`) | 조회, 감시, 알림 | 처음 도입할 때, 운영(prod) DB를 우선 지켜보기만 할 때 |
| 쓰기(`qa_writer`) | 위에 더해 일시정지·재개, 즉시 실행, 스케줄 수정, 삭제 | 화면에서 제어까지 할 때 |

- 읽기 전용 계정으로 등록하면 도구가 쓰기 권한이 없다고 감지해 제어 메뉴를 끕니다. 접속 화면에서 "읽기 전용"도 켜 두세요(쓰기 계정이어도 제어를 막고 싶을 때 같은 스위치를 씁니다).
- 쓰기 계정의 권한은 도구가 실제로 쓰는 문장에 맞춘 최소 권한입니다(TRD §5.5). 도구는 Quartz와 같은 방식으로 `QRTZ_LOCKS` 행을 잠그므로 `LOCKS`의 `UPDATE`가 꼭 필요합니다.
- 테이블을 만들거나 바꾸는 권한(DDL)은 주지 않습니다. 도구는 Quartz 테이블 구조를 바꾸지 않습니다.

## SQL

DB마다 아래 파일을 열어 `{{SCHEMA}}`, `{{READER_PASSWORD}}`, `{{WRITER_PASSWORD}}`를 바꾼 뒤 실행합니다. 두 계정 중 필요한 것만 실행해도 됩니다.

| DB | 파일 | 실행 계정 | `{{SCHEMA}}` |
| --- | --- | --- | --- |
| Oracle | [`db-accounts/oracle.sql`](db-accounts/oracle.sql) | DBA(SYSTEM 등) | Quartz 테이블을 가진 계정 이름(대문자, 예: `QUARTZ`) |
| PostgreSQL | [`db-accounts/postgresql.sql`](db-accounts/postgresql.sql) | 슈퍼유저 또는 `CREATEROLE` 권한이 있는 관리자 | 테이블이 있는 스키마(예: `public`) |
| MySQL, MariaDB | [`db-accounts/mysql.sql`](db-accounts/mysql.sql) | 계정을 만들 수 있는 관리자(root 등) | DB 이름(예: `quartz`) |

- 테이블 prefix가 `QRTZ_`가 아니면 파일의 `QRTZ_`(PostgreSQL은 `qrtz_`)를 바꾸세요.
- 스키마에 없는 테이블의 줄은 지우세요. 예를 들어 오래된 Quartz에는 `SIMPROP_TRIGGERS`가 없을 수 있습니다.
- MySQL·MariaDB는 테이블 이름의 대소문자를 구분하는 설정(Linux 기본)이면 실제 테이블 이름과 같은 대소문자로 써야 합니다. Quartz 기본 스크립트는 대문자(`QRTZ_TRIGGERS`)입니다.
- 접속 위치를 제한하려면 MySQL·MariaDB의 `'qa_reader'@'%'`에서 `%`를 quartz-admin 호스트 주소로 바꾸세요(PostgreSQL은 `pg_hba.conf`, Oracle은 네트워크 ACL이나 방화벽).
- 이 SQL은 CI 통합 테스트(`packages/store/test/integration/db-accounts.test.ts`)가 지원하는 모든 DB 버전에서 그대로 실행해, 만든 계정의 쓰기 가능 판정이 맞는지 확인합니다.

## 접속 등록

1. 화면의 접속 → 접속 추가에서 DB 종류, 호스트, 포트, 서비스 이름(Oracle) 또는 DB 이름, 위에서 만든 계정과 비밀번호를 넣습니다.
2. 읽기 전용·쓰기 계정은 테이블을 가진 계정과 다르므로 **스키마(선택)** 칸에 `{{SCHEMA}}`에 넣은 값을 꼭 넣습니다. 비워 두면 접속 계정 자신의 스키마에서 찾다가 테이블이 없다고 나옵니다(MySQL·MariaDB는 DB 이름이 곧 스키마라 따로 넣지 않습니다).
3. "연결 테스트하기"로 확인하고 저장하면 스케줄러를 감지합니다. 감지 결과의 "쓰기 가능"이 계정 종류와 맞는지 보세요. 쓰기 계정인데 쓰기 불가로 나오면 빠진 권한이 테이블별로 나옵니다.
