import type { AuthedRequest } from '../auth/decorators.js';
import { requestIdOf } from '../common/request-id.js';
import type { AuditActor } from './audit.service.js';

/**
 * 요청에서 감사 기록용 작업자 정보를 만든다.
 * @param user 세션이 아직 없을 때(로그인) 대신 쓸 사용자
 */
export function actorOf(
  req: AuthedRequest,
  user?: { id: number | null; username: string },
): AuditActor {
  const who = user ?? req.auth?.user;
  return {
    userId: who?.id ?? null,
    username: who?.username ?? null,
    ip: req.ip ?? null,
    requestId: requestIdOf(req),
  };
}
