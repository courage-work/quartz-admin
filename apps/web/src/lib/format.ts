function dateTimeFormat(timeZone?: string): Intl.DateTimeFormat {
  // sv-SE는 `2026-11-06 14:03:22` 형식을 준다
  return new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** epoch ms → 사용자 타임존의 `YYYY-MM-DD HH:mm:ss`. null이면 `-` */
export function formatDateTime(ms: number | null | undefined, timeZone?: string): string {
  if (ms === null || ms === undefined) return '-';
  return dateTimeFormat(timeZone).format(new Date(ms));
}

/**
 * `<input type="date">` 값(`YYYY-MM-DD`)을 사용자 타임존의 하루 시작 epoch ms로 바꾼다.
 * 형식이 틀리면 undefined.
 */
export function startOfLocalDay(value: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3]) ? undefined : d.getTime();
}

/**
 * 시작일과 종료일(둘 다 포함)을 API의 `from`(포함)·`to`(제외)로 바꾼다.
 * 종료일은 다음 날 0시로 넘긴다. 서머타임이 있는 타임존도 고려해 날짜로 계산한다.
 */
export function dateRange(fromDate: string, toDate: string): { from?: number; to?: number } {
  const from = startOfLocalDay(fromDate);
  const toStart = startOfLocalDay(toDate);
  let to: number | undefined;
  if (toStart !== undefined) {
    const d = new Date(toStart);
    d.setDate(d.getDate() + 1);
    to = d.getTime();
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}
