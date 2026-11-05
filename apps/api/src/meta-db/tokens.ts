export const META_DB_OPTIONS = Symbol('META_DB_OPTIONS');

export interface MetaDbOptions {
  /** SQLite 파일과 백업이 놓이는 디렉터리 (`QA_DATA_DIR`, 기본 `/data`) */
  dataDir: string;
  /** 일일 유지보수(백업, 보존 정리)를 실행할 시각 (로컬 시간, 0~23) */
  maintenanceHour: number;
}

export function resolveMetaDbOptions(overrides: Partial<MetaDbOptions> = {}): MetaDbOptions {
  return {
    dataDir: overrides.dataDir ?? process.env.QA_DATA_DIR ?? '/data',
    maintenanceHour: overrides.maintenanceHour ?? 3,
  };
}
