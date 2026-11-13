-- quartz-admin 접속 계정 예시 (PostgreSQL). docs/db-accounts.md 참고
-- 실행 계정: 슈퍼유저 또는 CREATEROLE 권한이 있는 관리자(GRANT는 테이블 소유자도 할 수 있다). 실행 전에 바꿔 넣을 값:
--   {{SCHEMA}}           Quartz 테이블이 있는 스키마(예: public)
--   {{READER_PASSWORD}}  읽기 전용 계정 비밀번호
--   {{WRITER_PASSWORD}}  쓰기(제어) 계정 비밀번호
-- 테이블 prefix가 QRTZ_가 아니면 바꾸고, 스키마에 없는 테이블(예: 오래된 Quartz의 SIMPROP_TRIGGERS)의 줄은 지운다.

-- 1) 읽기 전용 계정: 조회와 감시, 알림만 한다. 접속을 등록할 때 "읽기 전용"을 켠다
CREATE ROLE qa_reader LOGIN PASSWORD '{{READER_PASSWORD}}';
GRANT USAGE ON SCHEMA {{SCHEMA}} TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_job_details TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_simple_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_cron_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_simprop_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_blob_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_calendars TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_paused_trigger_grps TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_fired_triggers TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_scheduler_state TO qa_reader;
GRANT SELECT ON {{SCHEMA}}.qrtz_locks TO qa_reader;

-- 2) 쓰기(제어) 계정: 일시정지·재개, 즉시 실행, 스케줄 수정, 삭제까지 한다. 권한은 TRD §5.5 표와 같다
CREATE ROLE qa_writer LOGIN PASSWORD '{{WRITER_PASSWORD}}';
GRANT USAGE ON SCHEMA {{SCHEMA}} TO qa_writer;
GRANT SELECT, DELETE ON {{SCHEMA}}.qrtz_job_details TO qa_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{SCHEMA}}.qrtz_triggers TO qa_writer;
GRANT SELECT, INSERT, UPDATE, DELETE ON {{SCHEMA}}.qrtz_simple_triggers TO qa_writer;
GRANT SELECT, UPDATE, DELETE ON {{SCHEMA}}.qrtz_cron_triggers TO qa_writer;
GRANT SELECT, DELETE ON {{SCHEMA}}.qrtz_simprop_triggers TO qa_writer;
GRANT SELECT, DELETE ON {{SCHEMA}}.qrtz_blob_triggers TO qa_writer;
GRANT SELECT ON {{SCHEMA}}.qrtz_calendars TO qa_writer;
GRANT SELECT, INSERT, DELETE ON {{SCHEMA}}.qrtz_paused_trigger_grps TO qa_writer;
GRANT SELECT ON {{SCHEMA}}.qrtz_fired_triggers TO qa_writer;
GRANT SELECT ON {{SCHEMA}}.qrtz_scheduler_state TO qa_writer;
GRANT SELECT, INSERT, UPDATE ON {{SCHEMA}}.qrtz_locks TO qa_writer;
