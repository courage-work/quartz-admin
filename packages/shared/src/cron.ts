/**
 * cron 미리보기 API의 요청 스키마와 응답 타입 (TRD §7.6, B-20)
 *
 * 스케줄 수정 화면은 입력할 때마다(300ms 디바운스) `POST /cron/preview`로 문법을 검사하고 다음 실행 시각을 받는다.
 * 계산은 서버의 `@qa/core`(Quartz `CronExpression` 이식본)가 한다.
 */
import { z } from 'zod';
import { CRON_EXPRESSION_MAX, TIME_ZONE_ID_MAX } from './commands.js';

/** 미리보기로 받을 수 있는 다음 실행 시각 수 */
export const CRON_PREVIEW_MAX = 10;

/** `POST /cron/preview` */
export const cronPreviewRequestSchema = z.object({
  expression: z.string().max(CRON_EXPRESSION_MAX),
  /** Java TimeZone ID */
  timeZone: z.string().min(1).max(TIME_ZONE_ID_MAX),
  /** 다음 실행 시각 수. 기본 5 */
  count: z.number().int().min(1).max(CRON_PREVIEW_MAX).optional(),
  /** 이 시각 다음부터 계산한다(epoch ms). 없으면 서버 현재 시각 */
  after: z.number().int().positive().optional(),
});
export type CronPreviewRequest = z.infer<typeof cronPreviewRequestSchema>;

/** cron 검증 오류. `field`는 문제가 된 필드(초·분·시·일·월·요일·연도), 표현식 전체 문제면 없다 */
export interface CronErrorDto {
  /** `SYNTAX`(문법), `RANGE`(범위), `UNSUPPORTED`(Quartz는 받지만 도구가 계산할 수 없음), `QUARTZ`(Quartz가 거부), `TIME_ZONE`(타임존) */
  code: 'SYNTAX' | 'RANGE' | 'UNSUPPORTED' | 'QUARTZ' | 'TIME_ZONE';
  field?: string;
  message: string;
}

export type CronPreviewResponse =
  | {
      valid: true;
      /** Quartz가 저장하는 형태(대문자) */
      expression: string;
      /** 계산 기준 시각 */
      after: number;
      nextFireTimes: number[];
    }
  | { valid: false; after: number; error: CronErrorDto };

/** `GET /cron/time-zones`: 고를 수 있는 Java TimeZone ID */
export interface TimeZonesResponse {
  zones: string[];
}
