"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

const AlertDialogTrigger = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Trigger>
>(({ ...props }, ref) => (
  <AlertDialogPrimitive.Trigger
    ref={ref}
    data-slot="alert-dialog-trigger"
    {...props}
  />
));
AlertDialogTrigger.displayName = AlertDialogPrimitive.Trigger.displayName;

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
}

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    data-slot="alert-dialog-overlay"
    className={cn(
      "fixed inset-0 z-50 bg-[var(--oa-overlay)] duration-100 data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 supports-backdrop-filter:backdrop-blur-[3px]",
      className,
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> & {
    size?: "default" | "sm" | "lg";
    overlayClassName?: string;
  }
>(({ className, size = "default", style, overlayClassName, ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay className={overlayClassName} />
    <AlertDialogPrimitive.Content
      ref={ref}
      data-slot="alert-dialog-content"
      data-size={size}
      className={cn(
        "group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-[22px] border-solid border-[var(--oa-border)] bg-[var(--card)] p-6 text-[var(--card-foreground)] outline-none duration-100 sm:p-7 [border-width:var(--border-width)] data-[size=default]:max-w-[34rem] data-[size=sm]:max-w-[24rem] data-[size=lg]:max-w-[44rem] data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95",
        className,
      )}
      style={{
        borderColor:
          "color-mix(in srgb, var(--oa-border, var(--border)) 82%, transparent)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--card) 97%, var(--background) 3%) 0%, color-mix(in srgb, var(--card) 92%, var(--oa-bg-subtle) 8%) 100%)",
        boxShadow:
          "0 40px 100px -52px rgba(0, 0, 0, 0.55), 0 24px 48px -32px rgba(0, 0, 0, 0.28)",
        ...style,
      }}
      {...props}
    />
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "grid grid-rows-[auto_1fr] gap-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "mt-1 flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:flex-wrap sm:justify-end",
        className,
      )}
      style={{
        borderTop:
          "var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 68%, transparent)",
        ...style,
      }}
      {...props}
    />
  );
}

function AlertDialogMedia({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-[16px] bg-[var(--oa-bg-subtle)] text-[var(--oa-text-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-5",
        className,
      )}
      {...props}
    />
  );
}

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    data-slot="alert-dialog-title"
    className={cn(
      "text-ui-base font-medium leading-6 text-[var(--oa-text-strong)] sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
      className,
    )}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    data-slot="alert-dialog-description"
    className={cn(
      "text-ui-sm leading-[1.6] text-[var(--oa-text-muted)] text-balance break-words md:text-pretty *:[a]:text-[var(--oa-link)] *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-[var(--oa-link)]",
      className,
    )}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> &
    Pick<React.ComponentProps<typeof Button>, "variant" | "size">
>(({ className, variant = "default", size = "default", ...props }, ref) => (
  <Button variant={variant} size={size} asChild>
    <AlertDialogPrimitive.Action
      ref={ref}
      data-slot="alert-dialog-action"
      className={cn(className)}
      {...props}
    />
  </Button>
));
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel> &
    Pick<React.ComponentProps<typeof Button>, "variant" | "size">
>(({ className, variant = "secondary", size = "default", ...props }, ref) => (
  <Button variant={variant} size={size} asChild>
    <AlertDialogPrimitive.Cancel
      ref={ref}
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      {...props}
    />
  </Button>
));
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
