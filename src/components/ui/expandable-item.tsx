import * as React from "react"
import { cn } from "@/lib/utils"

interface ExpandableItemProps {
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  className?: string
}

interface ExpandableItemTriggerProps {
  children: React.ReactNode
  className?: string
}

interface ExpandableItemContentProps {
  children: React.ReactNode
  className?: string
}

const ExpandableItemContext = React.createContext<{
  expanded: boolean
  onToggle: () => void
} | null>(null)

function useExpandableItem() {
  const context = React.useContext(ExpandableItemContext)
  if (!context) {
    throw new Error("ExpandableItem components must be used within an ExpandableItem")
  }
  return context
}

function ExpandableItem({ expanded, onToggle, children, className }: ExpandableItemProps) {
  return (
    <ExpandableItemContext.Provider value={{ expanded, onToggle }}>
      <div
        className={cn(
          "border border-border rounded-control",
          expanded ? "ring-1 ring-ring" : "hover:bg-hover",
          className
        )}
      >
        {children}
      </div>
    </ExpandableItemContext.Provider>
  )
}

function ExpandableItemTrigger({ children, className }: ExpandableItemTriggerProps) {
  const { expanded, onToggle } = useExpandableItem()

  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-ui-sm text-muted-foreground",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        expanded && "border-b border-border",
        className
      )}
    >
      {children}
    </button>
  )
}

function ExpandableItemContent({ children, className }: ExpandableItemContentProps) {
  const { expanded } = useExpandableItem()

  if (!expanded) return null

  return (
    <div className={cn("p-3", className)}>
      {children}
    </div>
  )
}

export {
  ExpandableItem,
  ExpandableItemTrigger,
  ExpandableItemContent,
}
