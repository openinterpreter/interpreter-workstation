import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { resolveFloatingCollisionPadding } from "@/utils/floatingChromeInsets"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

const PopoverTrigger = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentProps<typeof PopoverPrimitive.Trigger>
>(({ ...props }, ref) => (
  <PopoverPrimitive.Trigger ref={ref} data-slot="popover-trigger" {...props} />
))
PopoverTrigger.displayName = "PopoverTrigger"

function PopoverContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 8,
  collisionPadding = 16,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={resolveFloatingCollisionPadding(collisionPadding)}
        className={cn(
          "z-50 w-80 max-w-[24rem] max-h-(--radix-popover-content-available-height) origin-(--radix-popover-content-transform-origin) overflow-y-auto rounded-[18px] p-0 text-[var(--popover-foreground)] duration-200 ease-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-3 data-[side=left]:slide-in-from-right-3 data-[side=right]:slide-in-from-left-3 data-[side=top]:slide-in-from-bottom-3",
          className
        )}
        style={{
          border:
            "var(--border-width) solid color-mix(in srgb, var(--border, var(--oa-border)) 78%, transparent)",
          background:
            "color-mix(in srgb, var(--popover, var(--oa-bg-app, var(--background))) 92%, var(--muted, var(--oa-bg-subtle, var(--background))) 8%)",
          boxShadow:
            "0 30px 70px -38px rgba(15, 23, 42, 0.28), 0 18px 32px -24px rgba(15, 23, 42, 0.18)",
          backdropFilter:
            "blur(18px) saturate(1.05)",
          ...style,
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

function PopoverClose({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

export { Popover, PopoverTrigger, PopoverContent, PopoverClose }
