import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap overflow-hidden rounded-[var(--oa-radius-sm)] border-solid px-2 py-0.5 text-ui-xs font-normal transition-[background-color,border-color,color] duration-150 [border-width:var(--border-width)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3! focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] text-[var(--oa-text)]",
        secondary: "border-transparent bg-[var(--oa-bg-hover)] text-[var(--oa-text-strong)]",
        destructive: "border-[var(--oa-danger-border)] bg-[var(--oa-danger-soft)] text-[var(--oa-danger)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline: "border-[var(--oa-border)] bg-transparent text-[var(--oa-text)]",
        ghost: "border-transparent bg-transparent text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-subtle)] hover:text-[var(--oa-text)]",
        link: "border-transparent bg-transparent px-0 text-[var(--oa-link)] underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
