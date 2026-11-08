'use client';

import { SearchIcon } from 'lucide-react';
import { useId, useRef } from 'react';

import { Field, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import { useSlashFocus } from '@/hooks/use-slash-focus';

/**
 * 목록 화면의 검색칸 (VectorLab list 패턴). 보이는 라벨에 검색 범위를 쓰고, `/`로 포커스한다.
 * 입력할 때마다 거르는 화면은 `onChange`만, 서버에 묻는 화면은 Enter로 `onSubmit`도 쓴다.
 */
export function ListSearch({
  label,
  value,
  onChange,
  onSubmit,
  className,
}: {
  /** 예: `검색(이름·호스트·태그)` */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  /** 바깥 배치(너비)만 */
  className?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  useSlashFocus(ref);
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={ref}
          id={id}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
            if (e.key === 'Escape' && value !== '') {
              e.preventDefault();
              onChange('');
            }
          }}
          aria-keyshortcuts="/"
        />
        <InputGroupAddon align="inline-end" className="pointer-coarse:hidden">
          {/* 터치 기기에는 키보드 단축키가 없으므로 숨긴다 */}
          <Kbd aria-hidden>/</Kbd>
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}
