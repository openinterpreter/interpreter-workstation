/**
 * Chat Container with auto-scroll functionality
 * Uses use-stick-to-bottom for smooth scrolling behavior
 */

import React from "react";
import { useTranslation } from 'react-i18next';
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ChatContainerRootProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export type ChatContainerContentProps = {
  children: React.ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export type ChatContainerScrollAnchorProps = {
  className?: string;
  ref?: React.RefObject<HTMLDivElement>;
} & React.HTMLAttributes<HTMLDivElement>;

export function ChatContainerRoot({
  children,
  className,
  ...props
}: ChatContainerRootProps) {
  return (
    <StickToBottom
      className={`flex overflow-hidden ${className || ""}`}
      resize="smooth"
      initial="smooth"
      role="log"
      {...props}
    >
      {children}
    </StickToBottom>
  );
}

export function ChatContainerContent({
  children,
  className,
  ...props
}: ChatContainerContentProps) {
  return (
    <StickToBottom.Content
      className={`flex w-full flex-col ${className || ""}`}
      data-chat-scroll-content
      {...props}
    >
      {children}
    </StickToBottom.Content>
  );
}

export function ChatContainerScrollAnchor({
  className,
  ...props
}: ChatContainerScrollAnchorProps) {
  return (
    <div
      className={`h-px w-full shrink-0 scroll-mt-4 ${className || ""}`}
      aria-hidden="true"
      {...props}
    />
  );
}

export function ScrollToBottomButton() {
  const { t } = useTranslation();
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  // Listen for scroll-to-bottom events from outside the context
  React.useEffect(() => {
    const handleScrollToBottom = () => scrollToBottom();
    window.addEventListener('chat:scroll-to-bottom', handleScrollToBottom);
    return () => window.removeEventListener('chat:scroll-to-bottom', handleScrollToBottom);
  }, [scrollToBottom]);

  return (
    <Button
      variant="secondary"
      size="icon-sm"
      onClick={() => scrollToBottom()}
      className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-20 shadow-lg ${isAtBottom ? "opacity-0 pointer-events-none" : "opacity-100"}`}
      title={t('chat.scrollToBottom')}
    >
      <ArrowDown />
    </Button>
  );
}
