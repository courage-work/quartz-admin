'use client';

import type {
  DetectedTableSetDto,
  DetectionDto,
  RegisterSchedulersRequest,
  SchedulerDto,
} from '@qa/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheckIcon, RadarIcon, ShieldAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { FormAlert } from '@/components/form/form-alert';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  BOOL_FORMAT_LABELS,
  CONNECTIONS_KEY,
  DETECTION_WARNING_LABELS,
  PRIVILEGE_LABELS,
  TEST_FAILURE_HINTS,
  unusableReason,
} from '@/lib/connections';
import { formatDateTime } from '@/lib/format';

/** 후보 하나를 가리키는 키. prefix가 빈 문자열일 수 있으므로 구분자를 둔다 */
const keyOf = (prefix: string, schedName: string) => `${prefix}\u0000${schedName}`;

function TableSetCard({
  set,
  selected,
  onToggle,
}: {
  set: DetectedTableSetDto;
  selected: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              테이블 세트 <span className="font-mono">{set.prefix || '(prefix 없음)'}</span>
            </span>
            {set.writeCapable ? (
              <Badge variant="success">
                <CircleCheckIcon data-icon="inline-start" aria-hidden />
                쓰기 가능
              </Badge>
            ) : (
              <Badge variant="warning">
                <ShieldAlertIcon data-icon="inline-start" aria-hidden />
                읽기 전용(권한 없음)
              </Badge>
            )}
          </div>
        </CardTitle>
        <CardDescription>
          예: <span className="font-mono">{set.tableNames.TRIGGERS}</span> · 불리언 저장 형식{' '}
          {BOOL_FORMAT_LABELS[set.boolFormat]}
          {set.boolFormatSource === 'default' ? '(잡이 없어 Quartz 기본값으로 판단)' : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {!set.writeCapable ? (
            <p className="text-sm text-muted-foreground">
              없는 권한:{' '}
              {set.missingPrivileges
                .map((m) => `${m.table} ${PRIVILEGE_LABELS[m.privilege]}`)
                .join(', ')}
              . 이 세트의 스케줄러는 조회만 할 수 있습니다.
            </p>
          ) : null}
          {set.warnings.map((w) => (
            <p key={w} className="text-sm text-muted-foreground">
              {DETECTION_WARNING_LABELS[w]}
            </p>
          ))}
          {set.schedulers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              테이블은 있지만 아직 SCHED_NAME이 없습니다. Quartz 노드를 한 번 띄우면 나타납니다.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">선택</span>
                  </TableHead>
                  <TableHead>SCHED_NAME</TableHead>
                  <TableHead className="text-right">잡</TableHead>
                  <TableHead className="text-right">트리거</TableHead>
                  <TableHead className="text-right">활성 노드 / 전체</TableHead>
                  <TableHead>상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {set.schedulers.map((c) => {
                  const key = keyOf(set.prefix, c.schedName);
                  const registered = c.registeredSchedulerId !== null;
                  const id = `candidate-${set.prefix}-${c.schedName}`;
                  return (
                    <TableRow key={key}>
                      <TableCell>
                        <Checkbox
                          id={id}
                          aria-label={`${c.schedName} 선택`}
                          disabled={registered}
                          checked={registered || selected.has(key)}
                          onCheckedChange={(v) => onToggle(key, v === true)}
                        />
                      </TableCell>
                      <TableCell>
                        <label htmlFor={id} className="font-mono">
                          {c.schedName}
                        </label>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{c.jobCount}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">{c.triggerCount}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="tabular-nums">
                          {c.activeNodeCount} / {c.nodeCount}
                        </span>
                      </TableCell>
                      <TableCell>
                        {registered ? (
                          <Badge variant="info">
                            <CircleCheckIcon data-icon="inline-start" aria-hidden />
                            등록됨
                          </Badge>
                        ) : c.activeNodeCount === 0 ? (
                          <Badge variant="neutral">활성 노드 없음</Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 스케줄러 감지와 등록 (FR-CON-03, 05). 감지는 대상 DB를 바꾸지 않는다.
 * 고른 후보를 등록하면 서버가 다시 감지해 카탈로그로 확인한 테이블 이름만 저장한다.
 */
export function DetectionPanel({
  connectionId,
  detection,
  detecting,
  detectError,
  onDetect,
}: {
  connectionId: number;
  detection: DetectionDto | undefined;
  detecting: boolean;
  detectError: { code: string; message: string } | null;
  onDetect: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickHint, setPickHint] = useState(false);

  // 새 감지 결과를 받았을 때, 이 접속에 등록한 스케줄러가 아직 없으면 찾은 후보를 모두 골라 둔다.
  // 처음 등록하는 흐름에서 체크를 한 번 더 누르지 않게 하기 위해서다. 이미 등록한 것이 있으면
  // 남은 후보는 일부러 빼 둔 것일 수 있어 고르지 않는다
  const [seenDetection, setSeenDetection] = useState(detection);
  if (seenDetection !== detection) {
    setSeenDetection(detection);
    const candidates = (detection?.tableSets ?? []).flatMap((set) =>
      set.schedulers.map((c) => ({ key: keyOf(set.prefix, c.schedName), c })),
    );
    if (
      selected.size === 0 &&
      candidates.length > 0 &&
      candidates.every(({ c }) => c.registeredSchedulerId === null)
    ) {
      setSelected(new Set(candidates.map(({ key }) => key)));
    }
  }

  const register = useMutation({
    mutationFn: (body: RegisterSchedulersRequest) =>
      api<SchedulerDto[]>(`/connections/${connectionId}/schedulers`, { method: 'POST', body }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`스케줄러 ${created.length}개를 등록했습니다`);
      setSelected(new Set());
      onDetect();
    },
    onError: (err) => toast.error(err.message),
  });

  const toggle = (key: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  const selections = (detection?.tableSets ?? []).flatMap((set) =>
    set.schedulers
      .filter(
        (c) => c.registeredSchedulerId === null && selected.has(keyOf(set.prefix, c.schedName)),
      )
      .map((c) => ({ prefix: set.prefix, schedName: c.schedName })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>스케줄러 감지</CardTitle>
        <CardDescription>
          카탈로그를 읽어 Quartz 테이블 세트와 SCHED_NAME을 찾습니다. 조회와 롤백하는 권한 점검만
          하므로 대상 DB의 행은 바뀌지 않습니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={detecting} onClick={onDetect}>
              {detecting ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RadarIcon data-icon="inline-start" aria-hidden />
              )}
              {detection ? '다시 감지하기' : '스케줄러 감지하기'}
            </Button>
            {detection ? (
              <span className="text-sm text-muted-foreground">
                스키마 <span className="font-mono">{detection.schema}</span> · DB 시각{' '}
                {formatDateTime(detection.dbNow)}
              </span>
            ) : null}
          </div>

          {detectError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>{detectError.message}</AlertTitle>
              <AlertDescription>{TEST_FAILURE_HINTS[detectError.code] ?? ''}</AlertDescription>
            </Alert>
          ) : null}

          {detection && detection.tableSets.length === 0 ? (
            <Alert variant="warning">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>Quartz 테이블을 찾지 못했습니다</AlertTitle>
              <AlertDescription>
                스키마 이름이 맞는지, 이 계정에 Quartz 테이블 조회 권한이 있는지 확인하세요.
              </AlertDescription>
            </Alert>
          ) : null}

          {detection?.unusable.map((u) => (
            <Alert key={u.prefix} variant="warning">
              <TriangleAlertIcon aria-hidden />
              <AlertTitle>
                <span className="font-mono">{u.prefix || '(prefix 없음)'}</span> 세트는 쓸 수
                없습니다
              </AlertTitle>
              <AlertDescription>{unusableReason(u)}</AlertDescription>
            </Alert>
          ))}

          {detection?.tableSets.map((set) => (
            <TableSetCard key={set.prefix} set={set} selected={selected} onToggle={toggle} />
          ))}

          {register.isError ? <FormAlert error={register.error} /> : null}

          {detection &&
          detection.tableSets.some((s) =>
            s.schedulers.some((c) => c.registeredSchedulerId === null),
          ) ? (
            <div>
              <Button
                disabled={register.isPending}
                onClick={() => {
                  // 버튼을 막는 대신 누르면 무엇이 필요한지 알려 준다
                  if (selections.length === 0) {
                    setPickHint(true);
                    return;
                  }
                  setPickHint(false);
                  register.mutate({ selections });
                }}
              >
                {register.isPending ? <Spinner data-icon="inline-start" /> : null}
                선택한 스케줄러 등록하기{selections.length > 0 ? ` (${selections.length})` : ''}
              </Button>
              {pickHint && selections.length === 0 ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  등록할 스케줄러를 표에서 하나 이상 고르세요.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
