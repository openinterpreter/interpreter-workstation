"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  const isSmall = size === "sm"

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex shrink-0 items-center rounded-full border-solid outline-none transition-[background-color,border-color,box-shadow] duration-150 [border-width:var(--border-width)] focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--brand-accent)] data-[state=unchecked]:border-[var(--oa-border-strong)] data-[state=unchecked]:bg-[var(--oa-bg-active)] data-disabled:cursor-not-allowed data-disabled:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2",
        isSmall ? "h-4 w-7" : "h-5 w-9",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-[var(--oa-bg-app)] shadow-[0_1px_2px_rgba(0,0,0,0.18)] ring-0 transition-transform duration-150 data-[state=checked]:bg-[var(--brand-accent-foreground)]",
          isSmall ? "ml-[2px] size-3 data-[state=checked]:translate-x-3" : "ml-[2px] size-4 data-[state=checked]:translate-x-4"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
