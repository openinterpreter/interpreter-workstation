import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        data-slot="input"
        className={cn(
          "h-[var(--oa-control-h-md)] w-full min-w-0 rounded-[var(--oa-radius-md)] border-solid border-[var(--oa-border)] bg-[var(--oa-bg-input)] px-3 py-2 text-ui-sm font-normal text-[var(--oa-text)] outline-none transition-[background-color,border-color,box-shadow] duration-150 [border-width:var(--border-width)] placeholder:text-[var(--oa-text-muted)] hover:border-[var(--oa-border-strong)] focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[var(--oa-bg-subtle)] disabled:opacity-50 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-ui-sm file:font-normal file:text-foreground md:text-ui-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
