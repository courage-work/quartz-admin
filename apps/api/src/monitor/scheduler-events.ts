import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

/** 스케줄러가 추가·변경·삭제됐다는 알림. 감시 루프가 바로 반영한다 (B-15) */
export type SchedulerEvent =
  /** 등록, 설정 변경, 접속 정보 변경. `immediate`면 다음 주기를 기다리지 않고 바로 감시한다 */
  | { type: 'upsert'; schedulerId: number; immediate?: boolean }
  | { type: 'remove'; schedulerId: number };

/**
 * 프로세스 안 이벤트 통로. 접속·스케줄러 관리 모듈이 보내고 감시 모듈이 받는다.
 * 두 모듈이 서로를 직접 참조하지 않게 하려고 둔다.
 */
@Injectable()
export class SchedulerEvents implements OnApplicationShutdown {
  private readonly subject = new Subject<SchedulerEvent>();

  get events(): Observable<SchedulerEvent> {
    return this.subject.asObservable();
  }

  emit(event: SchedulerEvent): void {
    this.subject.next(event);
  }

  onApplicationShutdown(): void {
    this.subject.complete();
  }
}
