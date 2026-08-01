"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={orientation}
      data-orientation={orientation}
      className={cn(
        "gap-2 group/tabs flex data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-[var(--oa-text-muted)] group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "rounded-[var(--oa-radius-md)] border-solid border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] p-1 [border-width:var(--border-width)] group-data-[orientation=horizontal]/tabs:h-[calc(var(--oa-control-h-sm)+8px)]",
        line: "gap-1 bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[var(--oa-control-h-sm)] flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--oa-radius-sm)] border-solid border-transparent px-3 text-ui-sm font-normal text-[var(--oa-text-muted)] outline-none transition-[background-color,border-color,color,box-shadow] duration-150 [border-width:var(--border-width)] hover:bg-[var(--oa-bg-hover)] hover:text-[var(--oa-text)] focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start group-data-[orientation=vertical]/tabs:px-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[state=active]:border-[var(--oa-border)] data-[state=active]:bg-[var(--oa-bg-app)] data-[state=active]:text-[var(--oa-text-strong)]",
        "after:absolute after:opacity-0 after:transition-opacity after:content-[''] group-data-[orientation=horizontal]/tabs:after:inset-x-3 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-[var(--border-width)] group-data-[orientation=horizontal]/tabs:after:bg-[var(--oa-text-strong)] group-data-[orientation=vertical]/tabs:after:inset-y-2 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-[var(--border-width)] group-data-[orientation=vertical]/tabs:after:bg-[var(--oa-text-strong)] group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100 group-data-[variant=line]/tabs-list:data-[state=active]:bg-[var(--oa-bg-subtle)] group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("text-ui-sm flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
