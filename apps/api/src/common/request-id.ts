import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 리버스 프록시가 붙인 값은 이 형식일 때만 이어 쓴다. 로그와 감사 기록에 임의 문자열이 들어가지 않게 하기 위해서다 */
const ACCEPTED_ID = /^[A-Za-z0-9._-]{8,64}$/;

type RequestWithId = Request & { requestId?: string };

/**
 * 요청마다 ID를 붙이고 응답 헤더로 돌려준다.
 * 감사 로그의 `request_id`와 서버 로그(TRD §11.3)를 같은 값으로 잇는다.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && ACCEPTED_ID.test(incoming) ? incoming : randomUUID();
  (req as RequestWithId).requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

export function requestIdOf(req: Request): string | null {
  return (req as RequestWithId).requestId ?? null;
}
