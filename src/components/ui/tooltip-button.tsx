import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { Button, buttonVariants } from "./button"
import { TooltipWrapper } from "./tooltip-wrapper"

export interface TooltipButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  /** The tooltip text shown on hover (also used as help panel title) */
  tooltip: string
  /** Optional description for help panel (defaults to tooltip if not provided) */
  helpDescription?: string
  /** Keyboard shortcut to display in tooltip (e.g., "⌘T") */
  shortcut?: string
  /** Side of the button where tooltip appears */
  tooltipSide?: "top" | "right" | "bottom" | "left"
  /** Whether to render as a child component */
  asChild?: boolean
}

/**
 * Button with tooltip and help panel integration.
 * Shows a tooltip on hover and provides data for the help panel.
 */
const TooltipButton = React.forwardRef<HTMLButtonElement, TooltipButtonProps>(
  ({ tooltip, helpDescription, shortcut, tooltipSide = "top", children, ...props }, ref) => {
    return (
      <TooltipWrapper tooltip={tooltip} helpDescription={helpDescription} shortcut={shortcut} tooltipSide={tooltipSide}>
        <Button ref={ref} {...props}>
          {children}
        </Button>
      </TooltipWrapper>
    )
  }
)
TooltipButton.displayName = "TooltipButton"

export { TooltipButton }
