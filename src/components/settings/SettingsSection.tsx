import { ReactNode, type ComponentProps, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import type { LucideIcon } from "lucide-react";

/**
 * Class that adds var(--border-width) dividers between sibling children.
 * Replaces Tailwind's divide-y (which uses 1px) with the app's 0.5px border.
 */
const DIVIDE_CLASS =
  "[&>*+*]:[border-top:var(--border-width)_solid_var(--border)]";

interface SettingsSectionProps {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  variant?: "card" | "plain";
  sectionId?: string;
}

/**
 * Shared settings surface used across the ChatGPT-style settings page.
 * Provides the soft card, compact section header, and consistent row dividers.
 */
export function SettingsSection({
  title,
  description,
  children,
  className,
  contentClassName,
  headerClassName,
  variant = "card",
  sectionId,
}: SettingsSectionProps) {
  const hasHeader = Boolean(title || description);
  const isPlain = variant === "plain";

  return (
    <section
      data-settings-section={sectionId}
      className={cn(
        !isPlain &&
          "overflow-hidden rounded-[18px] border bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_95%,var(--oa-bg-subtle,var(--muted))_5%)] shadow-[0_12px_36px_-28px_var(--shadow-color)]",
        isPlain && "bg-transparent py-7 first:pt-0 last:pb-0",
        className,
      )}
      style={
        !isPlain
          ? {
              borderWidth: "var(--border-width)",
              borderColor:
                "color-mix(in srgb, var(--oa-border, var(--border)) 58%, transparent)",
            }
          : undefined
      }
    >
      {hasHeader && (
        <div
          className={cn(
            isPlain ? "pb-3" : "px-5 py-4 sm:px-6",
            headerClassName,
          )}
        >
          {title && (
            <h3
              className={cn(
                "text-ui-sm font-medium text-foreground",
                isPlain && "tracking-[-0.01em]",
              )}
            >
              {title}
            </h3>
          )}
          {description && (
            <p className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
      )}
      <div
        className={cn(
          isPlain ? "py-0" : "px-5 py-0 sm:px-6",
          !isPlain &&
            hasHeader &&
            "[border-top:var(--border-width)_solid_var(--border)]",
          DIVIDE_CLASS,
          contentClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
  align?: "center" | "start";
  layout?: "default" | "wide";
  contentClassName?: string;
  helpTitle?: string;
  helpDescription?: string;
}

/**
 * A single settings row with label on left, control on right.
 * Description appears below the label if provided.
 */
export function SettingsRow({
  label,
  description,
  children,
  className,
  align = "center",
  layout = "default",
  contentClassName,
  helpTitle,
  helpDescription,
}: SettingsRowProps) {
  const isWideLayout = layout === "wide";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 py-[18px]",
        isWideLayout
          ? "lg:flex-row lg:justify-between lg:gap-10"
          : "sm:flex-row sm:justify-between sm:gap-10",
        isWideLayout
          ? align === "start"
            ? "lg:items-start"
            : "lg:items-center"
          : align === "start"
            ? "sm:items-start"
            : "sm:items-center",
        className,
      )}
      data-help-title={helpTitle ?? label}
      data-help-description={helpDescription ?? description ?? label}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui-sm font-medium leading-6 text-foreground">
          {label}
        </div>
        {description && (
          <div className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
            {description}
          </div>
        )}
      </div>
      <div
        className={cn(
          "flex w-full items-center",
          !isWideLayout && "sm:w-auto sm:shrink-0",
          isWideLayout && "lg:w-auto lg:shrink-0",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * A group of settings rows with a subtle header.
 * Use this to group related settings within a section.
 */
export function SettingsGroup({
  title,
  description,
  children,
  className,
}: SettingsGroupProps) {
  return (
    <div className={cn("py-4 first:pt-0 last:pb-0", className)}>
      {title && (
        <div className="mb-3">
          <div className="text-ui-xs font-medium text-muted-foreground">
            {title}
          </div>
          {description && (
            <p className="mt-1 max-w-2xl text-ui-sm leading-6 text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
      )}
      <div className={DIVIDE_CLASS}>{children}</div>
    </div>
  );
}

interface SettingsCardProps extends ComponentProps<"div"> {
  children: ReactNode;
  tone?: "default" | "muted" | "danger";
  style?: CSSProperties;
}

/**
 * Secondary inset surface for explanatory content, usage meters, and nested cards.
 */
export function SettingsCard({
  children,
  className,
  tone = "default",
  style,
  ...props
}: SettingsCardProps) {
  return (
    <div
      className={cn(
        "rounded-[12px] px-4 py-3.5",
        tone === "default" &&
          "bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_96%,var(--oa-bg-subtle,var(--muted))_4%)]",
        tone === "muted" &&
          "bg-[color-mix(in_srgb,var(--oa-bg-app,var(--background))_92%,var(--oa-bg-subtle,var(--muted))_8%)]",
        tone === "danger" && "border border-destructive/20 bg-destructive/5",
        className,
      )}
      style={{
        borderWidth: tone === "danger" ? "var(--border-width)" : "0px",
        borderColor:
          tone === "danger"
            ? undefined
            : "transparent",
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

interface SettingsSectionTitleProps {
  children: ReactNode;
  className?: string;
}

export function SettingsSectionTitle({
  children,
  className,
}: SettingsSectionTitleProps) {
  return (
    <div
      className={cn("text-ui-xs font-medium text-muted-foreground", className)}
    >
      {children}
    </div>
  );
}

interface SettingsPaneProps {
  children: ReactNode;
  className?: string;
}

export function SettingsPane({ children, className }: SettingsPaneProps) {
  return (
    <div className={cn("space-y-5", className)}>
      {children}
    </div>
  );
}

interface SettingsActionButtonProps
  extends Omit<ComponentProps<typeof Button>, "size"> {
  icon?: LucideIcon;
}

export function SettingsActionButton({
  icon: Icon,
  className,
  children,
  variant = "utility",
  ...props
}: SettingsActionButtonProps) {
  return (
    <Button
      variant={variant}
      size="sm"
      className={cn(
        "h-7 gap-1.5 rounded-[10px] px-2 text-ui-sm text-muted-foreground",
        className,
      )}
      data-icon={Icon ? "inline-start" : undefined}
      {...props}
    >
      {Icon ? <Icon className="size-3.5" /> : null}
      {children}
    </Button>
  );
}
