import { ArrowDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  createContext,
  useContext,
  useEffect,
  type CSSProperties,
  type HTMLAttributes,
} from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Button } from '../../../src/components/ui/button';
import { cn } from '../../../src/lib/utils';

type ChatScrollContextValue = ReturnType<typeof useStickToBottom>;

const ChatScrollContext = createContext<ChatScrollContextValue | null>(null);

function useChatScrollContext(): ChatScrollContextValue {
  const context = useContext(ChatScrollContext);
  if (!context) {
    throw new Error('chat scroll context must be used within ChatContainerRoot');
  }
  return context;
}

export function ChatContainerRoot({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const instance = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  });

  return (
    <ChatScrollContext.Provider value={instance}>
      <div
        className={cn('relative flex min-h-0 flex-col overflow-hidden', className)}
        role="log"
        {...props}
      >
        {children}
      </div>
    </ChatScrollContext.Provider>
  );
}

interface ChatContainerContentProps extends HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  viewportStyle?: CSSProperties;
}

export function ChatContainerContent({
  children,
  className,
  viewportClassName,
  viewportStyle,
  ...props
}: ChatContainerContentProps) {
  const { scrollRef, contentRef } = useChatScrollContext();

  return (
    <div
      ref={scrollRef}
      data-chat-scroll-container="true"
      className={cn("h-full w-full min-h-0 overflow-auto", viewportClassName)}
      style={viewportStyle}
    >
      <div ref={contentRef} className={cn('flex w-full flex-col', className)} {...props}>
        {children}
      </div>
    </div>
  );
}

export function ChatContainerScrollAnchor({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('h-px w-full shrink-0 scroll-mt-4', className)} aria-hidden="true" {...props} />;
}

export function ScrollToBottomButton() {
  const { t } = useTranslation();
  const { isAtBottom, scrollToBottom } = useChatScrollContext();

  useEffect(() => {
    const handleScrollToBottom = () => scrollToBottom();
    window.addEventListener('chat:scroll-to-bottom', handleScrollToBottom);
    return () => window.removeEventListener('chat:scroll-to-bottom', handleScrollToBottom);
  }, [scrollToBottom]);

  return (
    <Button
      variant="secondary"
      size="icon-sm"
      onClick={() => scrollToBottom()}
      className={cn(
        'absolute bottom-6 left-1/2 z-20 h-8 w-8 -translate-x-1/2 rounded-full border text-muted-foreground/80 shadow-none transition-all duration-150 hover:-translate-y-px hover:text-foreground',
        isAtBottom ? 'opacity-0 pointer-events-none' : 'opacity-100',
      )}
      style={{
        background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 80%, transparent)',
        borderColor: 'color-mix(in srgb, var(--oa-border, var(--border)) 58%, transparent)',
        boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
        backdropFilter: 'blur(10px)',
      }}
      title={t('chat.scrollToBottom')}
    >
      <ArrowDown />
    </Button>
  );
}
