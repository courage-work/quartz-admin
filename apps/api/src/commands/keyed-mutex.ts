/**
 * 키별 직렬화. 같은 키의 작업은 들어온 순서대로 하나씩 실행하고, 다른 키의 작업은 서로 기다리지 않는다.
 * 제어 명령을 스케줄러 단위로 하나씩 실행하는 데 쓴다(TRD §7.1 2단계). 프로세스 하나 안에서만 유효하며,
 * 단일 인스턴스 락(NFR-REL-04)이 프로세스가 하나뿐임을 보장한다.
 */
export class KeyedMutex<K> {
  private readonly tails = new Map<K, Promise<unknown>>();

  run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // 앞 작업의 성공·실패와 상관없이 다음 작업을 시작한다
    const result = prev.then(fn, fn);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      // 뒤에 줄 선 작업이 없으면 키를 지워 맵이 계속 커지지 않게 한다
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** 대기 중이거나 실행 중인 작업이 있는 키 수 */
  get size(): number {
    return this.tails.size;
  }
}
