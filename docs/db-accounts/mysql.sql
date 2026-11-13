-- quartz-admin 접속 계정 예시 (MySQL·MariaDB). docs/db-accounts.md 참고
-- 실행 계정: 계정을 만들 수 있는 관리자(root 등). 실행 전에 바꿔 넣을 값:
--   {{SCHEMA}}           Quartz 테이블이 있는 스키마(DB 이름)
--   {{READER_PASSWORD}}  읽기 전용 계정 비밀번호
--   {{WRITER_PASSWORD}}  쓰기(제어) 계정 비밀번호
-- 테이블 prefix가 QRTZ_가 아니면 바꾸고, 스키마에 없는 테이블(예: 오래된 Quartz의 SIMPROP_TRIGGERS)의 줄은 지운다.

-- 1) 읽기 전용 계정: 조회와 감시, 알림만 한다. 접속을 등록할 때 "읽기 전용"을 켠다
CREATE USER 'qa_reader'@'%' IDENTIFIED BY '{{READER_PASSWORD}}';
GRANT SELECT ON {{SCHEMA}}.QRTZ_JOB_DETAILS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_SIMPLE_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_CRON_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_SIMPROP_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_BLOB_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_CALENDARS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_PAUSED_TRIGGER_GRPS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_FIRED_TRIGGERS TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_SCHEDULER_STATE TO 'qa_reader'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_LOCKS TO 'qa_reader'@'%';

-- 2) 쓰기(제어) 계정: 일시정지·재개, 즉시 실행, 스케줄 수정, 삭제까지 한다. 권한은 TRD §5.5 표와 같다
CREATE USER 'qa_writer'@'%' IDENTIFIED BY '{{WRITER_PASSWORD}}';
GRANT SELECT, DELETE ON {{SCHEMA}}.QRTZ_JOB_DETAILS TO 'qa_writer'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON {{SCHEMA}}.QRTZ_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON {{SCHEMA}}.QRTZ_SIMPLE_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT, UPDATE, DELETE ON {{SCHEMA}}.QRTZ_CRON_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT, DELETE ON {{SCHEMA}}.QRTZ_SIMPROP_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT, DELETE ON {{SCHEMA}}.QRTZ_BLOB_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_CALENDARS TO 'qa_writer'@'%';
GRANT SELECT, INSERT, DELETE ON {{SCHEMA}}.QRTZ_PAUSED_TRIGGER_GRPS TO 'qa_writer'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_FIRED_TRIGGERS TO 'qa_writer'@'%';
GRANT SELECT ON {{SCHEMA}}.QRTZ_SCHEDULER_STATE TO 'qa_writer'@'%';
GRANT SELECT, INSERT, UPDATE ON {{SCHEMA}}.QRTZ_LOCKS TO 'qa_writer'@'%';
