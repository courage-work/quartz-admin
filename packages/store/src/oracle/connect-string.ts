import type { TargetConnectInfo } from '../adapter.js';
import { TargetError } from '../errors.js';

/** 호스트 이름, IPv4, IPv6. 접속 기술자를 깨뜨리는 괄호·등호·공백은 허용하지 않는다 */
const HOST_PATTERN = /^[A-Za-z0-9._:-]{1,253}$/;
/** 서비스 이름과 SID. 도메인이 붙은 서비스 이름(`orcl.example.com`)을 허용한다 */
const SERVICE_PATTERN = /^[A-Za-z0-9._$#-]{1,128}$/;

function invalid(field: string): TargetError {
  return new TargetError('TARGET_ERROR', {
    message: `접속 정보의 ${field} 형식이 올바르지 않습니다`,
  });
}

/**
 * oracledb 접속 문자열. 서비스 이름은 Easy Connect(`host:port/service`),
 * SID는 Easy Connect로 표현할 수 없어 접속 기술자를 만든다.
 */
export function oracleConnectString(info: TargetConnectInfo): string {
  if (!HOST_PATTERN.test(info.host)) throw invalid('호스트');
  if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65_535) throw invalid('포트');
  const service = info.oracleServiceName;
  const sid = info.oracleSid;
  if ((service ? 1 : 0) + (sid ? 1 : 0) !== 1) {
    throw new TargetError('TARGET_ERROR', {
      message: 'Oracle 접속에는 서비스 이름과 SID 중 하나만 지정해야 합니다',
    });
  }
  if (service !== undefined && service !== '') {
    if (!SERVICE_PATTERN.test(service)) throw invalid('서비스 이름');
    const host = info.host.includes(':') ? `[${info.host}]` : info.host;
    return `${host}:${info.port}/${service}`;
  }
  if (!SERVICE_PATTERN.test(sid!)) throw invalid('SID');
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${info.host})(PORT=${info.port}))(CONNECT_DATA=(SID=${sid})))`;
}
