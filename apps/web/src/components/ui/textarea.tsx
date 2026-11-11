import * as React from 'react';
import { cn } from 'cn';

/**
 * @param mono 코드성 값(그룹 이름 목록 등)을 받는 입력칸. 고정폭 글꼴(D2Coding)로 보여 준다(DESIGN §5)
 */
function Textarea({
  className,
  mono,
  ...props
}: React.ComponentProps<'textarea'> & { mono?: boolean }) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
