import * as React from "react"
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip"

export interface TooltipWrapperProps {
  /** The tooltip text shown on hover (also used as help panel title) */
  tooltip: string
  /** Optional description for help panel (defaults to tooltip if not provided) */
  helpDescription?: string
  /** Keyboard shortcut to display in tooltip (e.g., "⌘T") */
  shortcut?: string
  /** Side of the element where tooltip appears */
  tooltipSide?: "top" | "right" | "bottom" | "left"
  /** Distance between the trigger and tooltip */
  tooltipSideOffset?: number
  /** The element to wrap */
  children: React.ReactElement<{ 'data-help-title'?: string; 'data-help-description'?: string }>
}

/**
 * Base tooltip wrapper for any element.
 * Shows a tooltip on hover and injects help panel data attributes onto the child.
 */
function TooltipWrapper({
  tooltip,
  helpDescription,
  shortcut,
  tooltipSide = "top",
  tooltipSideOffset = 4,
  children,
}: TooltipWrapperProps) {
  const tooltipContent = shortcut ? (
    <span className="flex items-center gap-1.5">
      <span>{tooltip}</span>
      <span className="opacity-60">{shortcut}</span>
    </span>
  ) : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {React.cloneElement(children, {
          'data-help-title': tooltip,
          'data-help-description': helpDescription || tooltip,
        })}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={tooltipSideOffset}>
        {tooltipContent}
      </TooltipContent>
    </Tooltip>
  )
}

export { TooltipWrapper }
