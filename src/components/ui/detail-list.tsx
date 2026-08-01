import * as React from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { Button } from "./button"
import { cn } from "@/lib/utils"

interface DetailListItem {
  id: string
  name: string
  badge?: React.ReactNode
  meta?: React.ReactNode
  disabled?: boolean
}

interface DetailListSection<T extends DetailListItem> {
  title: string
  items: T[]
}

interface DetailListProps<T extends DetailListItem> {
  items?: T[]
  /** Optional grouped sections instead of flat items */
  sections?: DetailListSection<T>[]
  renderDetail: (item: T, onBack: () => void) => React.ReactNode
  renderAddNew?: (onBack: () => void) => React.ReactNode
  onItemClick?: (item: T) => void
  addNewLabel?: string
  emptyState?: React.ReactNode
  className?: string
  /** If provided, controls which item is shown in detail view externally */
  selectedId?: string | null
  /** Called when selection changes (for controlled mode) */
  onSelectionChange?: (id: string | null) => void
  /** Whether we're in "adding new" mode */
  isAddingNew?: boolean
  /** Called when adding new state changes */
  onAddingNewChange?: (adding: boolean) => void
  /** If provided, called instead of showing the add new view */
  onAddNewClick?: () => void
}

export function DetailList<T extends DetailListItem>({
  items: flatItems,
  sections,
  renderDetail,
  renderAddNew,
  onItemClick,
  addNewLabel = "Add new",
  emptyState,
  className,
  selectedId: controlledSelectedId,
  onSelectionChange,
  isAddingNew: controlledIsAddingNew,
  onAddingNewChange,
  onAddNewClick,
}: DetailListProps<T>) {
  // Internal state for uncontrolled mode
  const [internalSelectedId, setInternalSelectedId] = React.useState<string | null>(null)
  const [internalIsAddingNew, setInternalIsAddingNew] = React.useState(false)

  // Use controlled or uncontrolled state
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId
  const isAddingNew = controlledIsAddingNew !== undefined ? controlledIsAddingNew : internalIsAddingNew

  // Flatten sections to get all items for finding selected item
  const allItems = sections
    ? sections.flatMap(s => s.items)
    : flatItems || []

  const setSelectedId = (id: string | null) => {
    if (onSelectionChange) {
      onSelectionChange(id)
    } else {
      setInternalSelectedId(id)
    }
  }

  const setIsAddingNew = (adding: boolean) => {
    if (onAddingNewChange) {
      onAddingNewChange(adding)
    } else {
      setInternalIsAddingNew(adding)
    }
  }

  const selectedItem = allItems.find(item => item.id === selectedId)

  const handleBack = () => {
    setSelectedId(null)
    setIsAddingNew(false)
  }

  const handleItemClick = (item: T) => {
    if (item.disabled) return
    if (onItemClick) {
      onItemClick(item)
    } else {
      setSelectedId(item.id)
      setIsAddingNew(false)
    }
  }

  const handleAddNew = () => {
    if (onAddNewClick) {
      onAddNewClick()
    } else {
      setIsAddingNew(true)
      setSelectedId(null)
    }
  }

  // Show detail view
  if (selectedItem) {
    return (
      <div className={className}>
        {renderDetail(selectedItem, handleBack)}
      </div>
    )
  }

  // Show add new view
  if (isAddingNew && renderAddNew) {
    return (
      <div className={className}>
        {renderAddNew(handleBack)}
      </div>
    )
  }

  // Show list view
  if (allItems.length === 0 && !renderAddNew && !onAddNewClick) {
    return emptyState || null
  }

  // Render with sections if provided, otherwise flat list
  const renderItems = (items: T[]) => (
    items.map(item => (
      <DetailListItemComponent
        key={item.id}
        item={item}
        onClick={() => handleItemClick(item)}
      />
    ))
  )

  const addNewButton = (renderAddNew || onAddNewClick) && (
    onAddNewClick ? (
      <button
        type="button"
        onClick={handleAddNew}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-ui-sm text-muted-foreground hover:!text-foreground hover:!bg-transparent active:!text-foreground active:!bg-transparent focus:outline-none"
      >
        {addNewLabel}
      </button>
    ) : (
      <button
        type="button"
        onClick={handleAddNew}
        className="w-full flex items-center gap-2 px-3 py-2 text-left border border-dashed border-border rounded-control text-ui-sm text-muted-foreground hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-3.5" />
        {addNewLabel}
      </button>
    )
  )

  if (sections) {
    return (
      <div className={cn("space-y-4", className)}>
        {allItems.length === 0 && emptyState}

        {sections.map((section) => (
          section.items.length > 0 && (
            <div key={section.title} className="space-y-1">
              <div className="text-ui-xs font-medium text-muted-foreground px-1 py-1">
                {section.title}
              </div>
              {renderItems(section.items)}
            </div>
          )
        ))}

        {addNewButton}
      </div>
    )
  }

  return (
    <div className={cn("space-y-1", className)}>
      {allItems.length === 0 && emptyState}

      {flatItems && renderItems(flatItems)}

      {addNewButton}
    </div>
  )
}

function DetailListItemComponent<T extends DetailListItem>({
  item,
  onClick,
}: {
  item: T
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={item.disabled}
      className={cn(
        "w-full flex items-center justify-between gap-2 px-3 py-2 text-left border border-border rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        item.disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-hover"
      )}
    >
      <span className="flex items-center gap-2 text-ui-sm text-muted-foreground min-w-0">
        <span className="truncate">{item.name}</span>
        {item.badge}
      </span>
      <span className="flex items-center gap-2 shrink-0">
        {item.meta}
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </span>
    </button>
  )
}

// Breadcrumb item type
interface BreadcrumbItem {
  label: string
  onClick?: () => void
}

// Header component for detail views with breadcrumb support
interface DetailListHeaderProps {
  title: string
  onBack: () => void
  /** Optional breadcrumb path. If provided, renders as breadcrumbs instead of back button + title */
  breadcrumbs?: BreadcrumbItem[]
}

export function DetailListHeader({ title, onBack, breadcrumbs }: DetailListHeaderProps) {
  // If breadcrumbs provided, render breadcrumb navigation
  if (breadcrumbs && breadcrumbs.length > 0) {
    return (
      <nav className="flex items-center gap-1 mb-4 text-ui-sm" aria-label="Breadcrumb">
        {breadcrumbs.map((crumb, index) => (
          <div key={index} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="size-3 text-muted-foreground" />}
            {crumb.onClick ? (
              <button
                type="button"
                onClick={crumb.onClick}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {crumb.label}
              </button>
            ) : (
              <span className="text-foreground font-medium">{crumb.label}</span>
            )}
          </div>
        ))}
      </nav>
    )
  }

  // Default: back button + title
  return (
    <div className="flex items-center gap-3 mb-4">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onBack}
        aria-label="Go back"
        className="text-muted-foreground shrink-0"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <h2 className="text-ui-base font-medium text-foreground">{title}</h2>
    </div>
  )
}

export type { DetailListItem, DetailListSection, DetailListProps, BreadcrumbItem }
