import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import {
  CronTriggerCalc,
  CronValidationError,
  JAVA_ZONE_IDS,
  UnsupportedTimeZoneError,
  resolveJavaTimeZone,
  validateCron,
} from '@qa/core';
import {
  type CronPreviewRequest,
  cronPreviewRequestSchema,
  type CronPreviewResponse,
  type TimeZonesResponse,
} from '@qa/shared';
import { CLOCK, type Clock } from '../common/clock.js';
import { ZodPipe } from '../common/zod.pipe.js';

/** 미리보기 기본 개수 (FR-CTL-06: 다음 실행 5개) */
const DEFAULT_COUNT = 5;

/**
 * cron 미리보기 (TRD §7.6, B-20). 스케줄 수정 화면이 입력할 때마다 문법을 검사하고 다음 실행 시각을 받는다.
 * 대상 DB를 읽지 않고 `@qa/core`(Quartz `CronExpression` 이식본)로 계산한다. 기준 시각은 서버 시각이다.
 * 실제로 저장할 다음 실행 시각은 명령 미리보기가 대상 DB 시각과 트리거의 시작·종료 시각으로 다시 계산한다.
 */
@Controller('cron')
export class CronController {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Body(new ZodPipe(cronPreviewRequestSchema)) body: CronPreviewRequest,
  ): CronPreviewResponse {
    const after = body.after ?? this.clock();
    const expression = body.expression.trim().toUpperCase();
    const validation = validateCron(expression);
    if (!validation.ok) {
      const { code, field, message } = validation.error;
      return { valid: false, after, error: { code, ...(field ? { field } : {}), message } };
    }
    const zone = (() => {
      try {
        return resolveJavaTimeZone(body.timeZone);
      } catch (err) {
        if (err instanceof UnsupportedTimeZoneError) return null;
        throw err;
      }
    })();
    if (zone === null || zone.fallbackToGmt) {
      return {
        valid: false,
        after,
        error: {
          code: 'TIME_ZONE',
          message: `알 수 없거나 지원하지 않는 타임존입니다: ${body.timeZone}`,
        },
      };
    }
    let calc: CronTriggerCalc;
    try {
      calc = new CronTriggerCalc({
        cronExpression: expression,
        timeZoneId: zone.javaId,
        startTime: after,
      });
    } catch (err) {
      if (err instanceof CronValidationError) {
        return { valid: false, after, error: { code: err.error.code, message: err.message } };
      }
      throw err;
    }
    const nextFireTimes: number[] = [];
    for (
      let t = calc.fireTimeAfter(after);
      t !== null && nextFireTimes.length < (body.count ?? DEFAULT_COUNT);
      t = calc.fireTimeAfter(t)
    ) {
      nextFireTimes.push(t);
    }
    return { valid: true, expression, after, nextFireTimes };
  }

  /** 고를 수 있는 Java TimeZone ID. 이 런타임에서 계산할 수 없는 ID는 뺀다 */
  @Get('time-zones')
  timeZones(): TimeZonesResponse {
    return { zones: SUPPORTED_ZONES };
  }
}

const SUPPORTED_ZONES: string[] = JAVA_ZONE_IDS.filter((id) => {
  try {
    return !resolveJavaTimeZone(id).fallbackToGmt;
  } catch {
    return false;
  }
});
