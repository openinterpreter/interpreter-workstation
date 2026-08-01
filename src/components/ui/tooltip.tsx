import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  delayDuration,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root> & {
  delayDuration?: number
}) {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipPrimitive.Root data-slot="tooltip" disableHoverableContent {...props} />
    </TooltipProvider>
  )
}

const TooltipTrigger = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentProps<typeof TooltipPrimitive.Trigger>
>(({ ...props }, ref) => (
  <TooltipPrimitive.Trigger ref={ref} data-slot="tooltip-trigger" {...props} />
))
TooltipTrigger.displayName = "TooltipTrigger"

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-w-xs px-2 py-1 text-ui-xs rounded-md",
          className
        )}
        style={{ backgroundColor: '#1a1a1a', color: '#ffffff' }}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
