'use client';

import { useId, type ReactNode } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

import { FormRow } from './form-row';

/**
 * react-hook-form에 연결한 입력 하나. 라벨은 항상 보이게 두고, 오류는 입력 아래에 보여 준다 (DESIGN §10).
 *
 * - `layout="stack"`(기본): 라벨이 입력 위. 로그인, 시트처럼 좁은 곳
 * - `layout="row"`: 라벨이 왼쪽(`FormRow`). 추가·수정·설정 화면 (B-40)
 * - `size="short"`: 포트·숫자처럼 짧은 값. 넓은 화면에서 입력 폭을 줄인다
 */
export function TextField<T extends FieldValues>({
  form,
  name,
  label,
  type = 'text',
  autoComplete,
  description,
  autoFocus,
  layout = 'stack',
  size = 'default',
}: {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  type?: 'text' | 'password';
  autoComplete?: string;
  description?: ReactNode;
  autoFocus?: boolean;
  layout?: 'stack' | 'row';
  size?: 'default' | 'short';
}) {
  const id = useId();
  const { error } = form.getFieldState(name, form.formState);
  const inputProps = {
    id,
    type,
    autoComplete,
    autoFocus,
    'aria-invalid': error ? true : undefined,
    ...form.register(name, {
      // 폼은 mode: 'onSubmit'이다. 값을 바꾼 칸만 벗어날 때 검사한다. 아무것도 입력하지 않은 칸은
      // 다른 곳을 눌러 포커스가 빠져도 오류를 띄우지 않고, 저장할 때 검사한다 (DESIGN §8.1.3)
      onBlur: () => {
        if (form.getFieldState(name).isDirty) void form.trigger(name);
      },
      // 오류가 떠 있으면 고치는 즉시 다시 검사해 지운다
      onChange: () => {
        if (form.getFieldState(name).error) void form.trigger(name);
      },
    }),
  };
  const help = (
    <>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={[error]} />
    </>
  );

  if (layout === 'row')
    return (
      <FormRow label={label} htmlFor={id} invalid={!!error}>
        <Field data-invalid={error ? true : undefined}>
          {/* 입력 폭은 값 길이에 맞춘다. 3/4 칸을 다 채우면 넓은 화면에서 지나치게 길다 */}
          {size === 'short' ? (
            <Input {...inputProps} className="md:w-40" />
          ) : (
            <Input {...inputProps} className="md:max-w-xl" />
          )}
          {help}
        </Field>
      </FormRow>
    );

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input {...inputProps} />
      {help}
    </Field>
  );
}
