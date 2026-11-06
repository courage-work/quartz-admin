'use client';

import { useId, type ReactNode } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';

import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * react-hook-form에 연결한 입력 하나. 라벨은 항상 보이게 두고, 오류는 입력 아래에 보여 준다 (DESIGN §10).
 */
export function TextField<T extends FieldValues>({
  form,
  name,
  label,
  type = 'text',
  autoComplete,
  description,
  autoFocus,
}: {
  form: UseFormReturn<T>;
  name: Path<T>;
  label: string;
  type?: 'text' | 'password';
  autoComplete?: string;
  description?: ReactNode;
  autoFocus?: boolean;
}) {
  const id = useId();
  const { error } = form.getFieldState(name, form.formState);
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        {...form.register(name)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError errors={[error]} />
    </Field>
  );
}
