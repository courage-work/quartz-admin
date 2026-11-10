'use client';

import type { GroupOptions } from '@qa/shared';
import { useState } from 'react';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ALL = 'all';
/** 선택 상자 값. 이름이 `all`인 그룹과 "전체"가 겹치지 않게 앞에 표시를 붙인다 */
const PREFIX = 'g:';

interface Props {
  id: string;
  value: string | undefined;
  onChange: (group: string | undefined) => void;
  /** 그룹 선택지(`GET /schedulers/:id/groups`). 아직 못 읽었으면 undefined */
  options: GroupOptions | undefined;
  /** 직접 입력으로 바뀌었을 때 글자마다 알린다(팝오버 안의 초안). 기본은 Enter나 포커스가 빠질 때 */
  live?: boolean;
  /** 바깥 배치(너비)만 */
  className?: string;
}

/**
 * 그룹 필터. 그룹 이름을 외워서 치지 않도록 대상 DB에 있는 그룹 중에서 고른다.
 * 그룹이 너무 많아 선택지를 다 받지 못했으면(`truncated`) 직접 입력받는다(정확히 일치).
 */
export function GroupField({ id, value, onChange, options, live, className }: Props) {
  if (options?.truncated) {
    return (
      <GroupInput id={id} value={value} onChange={onChange} live={live} className={className} />
    );
  }
  const listed = options?.items ?? [];
  // 주소로 들어온 그룹이 목록에 없어도(지워진 그룹) 고른 값은 보이게 한다
  const items = value !== undefined && !listed.includes(value) ? [value, ...listed] : listed;
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>그룹</FieldLabel>
      <Select
        value={value === undefined ? ALL : PREFIX + value}
        onValueChange={(v) => onChange(v === ALL ? undefined : v.slice(PREFIX.length))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={ALL}>전체</SelectItem>
            {items.map((g) => (
              <SelectItem key={g} value={PREFIX + g}>
                <span className="font-mono">{g}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function GroupInput({ id, value, onChange, live, className }: Omit<Props, 'options'>) {
  const [text, setText] = useState(value ?? '');
  // 바깥에서 값이 바뀌면(필터 지우기) 입력칸도 맞춘다
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value ?? '');
  }
  const commit = (next: string) => {
    if ((next || undefined) !== value) onChange(next || undefined);
  };
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>그룹(정확히 일치)</FieldLabel>
      <Input
        id={id}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (live) commit(e.target.value);
        }}
        onBlur={() => commit(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !live) {
            e.preventDefault();
            commit(text);
          }
        }}
      />
      <FieldDescription>그룹이 많아 목록 대신 이름을 직접 입력합니다.</FieldDescription>
    </Field>
  );
}
