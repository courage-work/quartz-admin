export const META_DB_OPTIONS = Symbol('META_DB_OPTIONS');

export interface MetaDbOptions {
  /** SQLite 파일과 백업이 놓이는 디렉터리 (`QA_DATA_DIR`) */
  dataDir: string;
  /** 일일 유지보수(백업, 보존 정리)를 실행할 시각 (로컬 시간, 0~23) */
  maintenanceHour: number;
}

export const DEFAULT_MAINTENANCE_HOUR = 3;
