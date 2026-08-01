import * as React from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { ChevronDown, Check } from 'lucide-react'

import { cn } from '@/lib/utils'
import { resolveFloatingCollisionPadding } from '@/utils/floatingChromeInsets'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'

const Combobox = ComboboxPrimitive.Root

function ComboboxValue(props: ComboboxPrimitive.Value.Props) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />
}

const ComboboxTrigger = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Trigger>,
  React.ComponentProps<typeof ComboboxPrimitive.Trigger> & {
    showChevron?: boolean
  }
>(({ className, children, showChevron = true, ...props }, ref) => {
  return (
    <ComboboxPrimitive.Trigger
      ref={ref}
      data-slot="combobox-trigger"
      className={cn(
        'flex h-8 w-full items-center justify-between gap-2 rounded-control bg-background px-2.5 text-left text-ui-sm outline-none hover:bg-hover disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      style={{ border: 'var(--border-width) solid var(--border)' }}
      {...props}
    >
      {children}
      {showChevron && <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
    </ComboboxPrimitive.Trigger>
  )
})
ComboboxTrigger.displayName = 'ComboboxTrigger'

const ComboboxInput = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Input>,
  ComboboxPrimitive.Input.Props & {
    inputGroupClassName?: string
    showTrigger?: boolean
  }
>(({ className, inputGroupClassName, showTrigger = true, disabled, ...props }, ref) => {
  return (
    <InputGroup className={cn('w-auto', inputGroupClassName)}>
      <ComboboxPrimitive.Input
        ref={ref}
        data-slot="combobox-input"
        render={<InputGroupInput disabled={disabled} />}
        className={className}
        disabled={disabled}
        {...props}
      />
      {showTrigger && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            asChild
            data-slot="combobox-trigger-button"
            className="data-pressed:bg-transparent"
            disabled={disabled}
          >
            <ComboboxTrigger className="size-6 rounded-control border-0 bg-transparent p-0 hover:bg-transparent" />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  )
})
ComboboxInput.displayName = 'ComboboxInput'

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  align = 'start',
  alignOffset = 0,
  anchor,
  collisionPadding = 8,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'anchor' | 'collisionPadding'
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={resolveFloatingCollisionPadding(collisionPadding)}
        className="z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin) overflow-hidden shadow-xl backdrop-blur-xl duration-100',
            className,
          )}
          style={{
            backgroundColor: 'color-mix(in srgb, var(--background) 85%, transparent)',
            border: 'var(--border-width) solid var(--border)',
            borderRadius: 'var(--control-radius-lg)',
          }}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

const ComboboxList = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.List>,
  React.ComponentProps<typeof ComboboxPrimitive.List>
>(({ className, ...props }, ref) => {
  return (
    <ComboboxPrimitive.List
      ref={ref}
      data-slot="combobox-list"
      className={cn('max-h-80 overflow-y-auto overscroll-contain pr-1', className)}
      {...props}
    />
  )
})
ComboboxList.displayName = 'ComboboxList'

const ComboboxGroup = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Group>,
  React.ComponentProps<typeof ComboboxPrimitive.Group>
>(({ className, ...props }, ref) => {
  return <ComboboxPrimitive.Group ref={ref} data-slot="combobox-group" className={cn(className)} {...props} />
})
ComboboxGroup.displayName = 'ComboboxGroup'

const ComboboxGroupLabel = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.GroupLabel>,
  React.ComponentProps<typeof ComboboxPrimitive.GroupLabel>
>(({ className, ...props }, ref) => {
  return (
    <ComboboxPrimitive.GroupLabel
      ref={ref}
      data-slot="combobox-group-label"
      className={cn('px-1 text-ui-xs uppercase tracking-wider text-muted-foreground', className)}
      {...props}
    />
  )
})
ComboboxGroupLabel.displayName = 'ComboboxGroupLabel'

const ComboboxItem = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Item>,
  React.ComponentProps<typeof ComboboxPrimitive.Item> & {
    showIndicator?: boolean
  }
>(({ className, children, showIndicator = true, ...props }, ref) => {
  return (
    <ComboboxPrimitive.Item
      ref={ref}
      data-slot="combobox-item"
      className={cn(
        'data-highlighted:bg-hover flex w-full items-start justify-between gap-3 rounded-control px-3 py-2 text-left text-ui-sm outline-none data-[selected]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      {showIndicator && (
        <ComboboxPrimitive.ItemIndicator
          render={<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground" />}
        >
          <Check className="size-4" />
        </ComboboxPrimitive.ItemIndicator>
      )}
    </ComboboxPrimitive.Item>
  )
})
ComboboxItem.displayName = 'ComboboxItem'

const ComboboxEmpty = React.forwardRef<
  React.ComponentRef<typeof ComboboxPrimitive.Empty>,
  React.ComponentProps<typeof ComboboxPrimitive.Empty>
>(({ className, ...props }, ref) => {
  return (
    <ComboboxPrimitive.Empty
      ref={ref}
      data-slot="combobox-empty"
      className={cn(
        'rounded-control bg-muted/40 px-3 py-4 text-center text-ui-sm text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
})
ComboboxEmpty.displayName = 'ComboboxEmpty'

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
}
