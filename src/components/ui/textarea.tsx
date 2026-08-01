import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full rounded-[var(--oa-radius-md)] border-solid border-[var(--oa-border)] bg-[var(--oa-bg-input)] px-3 py-2.5 text-ui-sm text-[var(--oa-text)] outline-none transition-[background-color,border-color,box-shadow] duration-150 [border-width:var(--border-width)] placeholder:text-[var(--oa-text-muted)] hover:border-[var(--oa-border-strong)] focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 field-sizing-content md:text-ui-sm disabled:cursor-not-allowed disabled:bg-[var(--oa-bg-subtle)] disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
