import * as React from 'react';
import { cn } from 'cn';

/**
 * @param mono 코드성 값(cron 표현식 등)을 받는 입력칸. 고정폭 글꼴(D2Coding)로 보여 준다(DESIGN §5)
 */
function Input({
  className,
  type,
  mono,
  ...props
}: React.ComponentProps<'input'> & { mono?: boolean }) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 pointer-coarse:h-11 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
