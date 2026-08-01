import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { usePressState } from "./usePressState"

const buttonVariants = cva(
  "relative isolate inline-flex shrink-0 items-center justify-center overflow-hidden whitespace-nowrap select-none text-ui-sm font-normal outline-none transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-[230ms] ease-[cubic-bezier(0.22,1,0.36,1)] transform-gpu data-[pressed=true]:scale-[0.985] motion-reduce:transform-none motion-reduce:duration-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 border-solid [border-width:var(--border-width)] [background-clip:padding-box] group/button",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--brand-accent)] text-[var(--brand-accent-foreground)] hover:opacity-95",
        outline: "border-[var(--oa-border)] bg-[var(--oa-bg-input)] text-[var(--oa-text)] hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)] aria-expanded:border-[var(--oa-border-strong)] aria-expanded:bg-[var(--oa-bg-hover)]",
        secondary: "border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] text-[var(--oa-text)] hover:border-[var(--oa-border-strong)] hover:bg-[var(--oa-bg-hover)] aria-expanded:border-[var(--oa-border-strong)] aria-expanded:bg-[var(--oa-bg-hover)]",
        ghost: "border-transparent bg-transparent text-[var(--oa-text)] hover:bg-[var(--oa-bg-hover)] aria-expanded:bg-[var(--oa-bg-hover)]",
        utility: "oa-hover-chip border-transparent bg-transparent text-[var(--oa-text-muted)] shadow-none hover:text-[var(--oa-text)] aria-expanded:bg-[var(--oa-button-hover-bg)] aria-expanded:text-[var(--oa-text)]",
        destructive: "border-[var(--oa-danger-border)] bg-[var(--oa-danger-soft)] text-[var(--oa-danger)] hover:bg-[var(--oa-danger-soft-strong)] focus-visible:border-[var(--oa-danger-border)]",
        link: "border-transparent bg-transparent px-0 text-[var(--oa-link)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[var(--oa-control-h-md)] gap-2 rounded-[var(--oa-radius-md)] px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        lg: "h-[var(--oa-control-h-lg)] gap-2.5 rounded-[var(--oa-radius-lg)] px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        row: "h-[var(--unit-height-small)] gap-[var(--unit-padding)] rounded-[var(--oa-radius-md)] px-[var(--unit-padding)] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        element: "h-[var(--unit-element-height)] gap-[var(--unit-padding)] rounded-[var(--oa-radius-md)] px-[var(--unit-padding)] [&_svg:not([class*='size-'])]:size-4",
        icon: "size-[var(--oa-control-h-md)] rounded-[var(--oa-radius-md)]",
        "icon-lg": "size-[var(--oa-control-h-lg)] rounded-[var(--oa-radius-lg)]",
        "icon-row": "h-[var(--unit-height-small)] w-[var(--unit-height-small)] rounded-[var(--oa-radius-md)] [&_svg:not([class*='size-'])]:size-4",
        "icon-element": "h-[var(--unit-element-height)] w-[var(--unit-element-height)] rounded-[var(--oa-radius-md)] [&_svg:not([class*='size-'])]:size-4",
        xs: "h-6 gap-1.5 rounded-[var(--oa-radius-sm)] px-2 text-ui-sm [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-[var(--oa-control-h-sm)] gap-1.5 rounded-[var(--oa-radius-sm)] px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-xs": "size-6 rounded-[var(--oa-radius-sm)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-[var(--oa-radius-sm)]",
        "icon-toolbar": "size-5 rounded-[var(--oa-radius-sm)] [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(({ className, variant = "default", size = "default", asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : "button"
  const { pressed, pressProps } = usePressState<HTMLButtonElement>(!!props.disabled)
  const {
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    onKeyDown,
    onKeyUp,
    onBlur,
    ...restProps
  } = props

  const handlePointerDown: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onPointerDown(event)
    onPointerDown?.(event)
  }

  const handlePointerUp: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onPointerUp(event)
    onPointerUp?.(event)
  }

  const handlePointerLeave: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onPointerLeave(event)
    onPointerLeave?.(event)
  }

  const handlePointerCancel: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onPointerCancel(event)
    onPointerCancel?.(event)
  }

  const handleKeyDown: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onKeyDown(event)
    onKeyDown?.(event)
  }

  const handleKeyUp: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onKeyUp(event)
    onKeyUp?.(event)
  }

  const handleBlur: React.FocusEventHandler<HTMLButtonElement> = (event) => {
    pressProps.onBlur(event)
    onBlur?.(event)
  }

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-corner-shape="round"
      data-variant={variant}
      data-size={size}
      data-pressed={pressed ? 'true' : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      {...restProps}
    />
  )
})
Button.displayName = "Button"

export { Button, buttonVariants }
