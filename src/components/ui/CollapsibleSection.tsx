import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SECTION_HEADER_ID, SECTION_EXPANDED_ID, SECTION_COLLAPSED_ID, CHEVRON_DOWN_ID, CHEVRON_RIGHT_ID } from '../../../shared/element-ids';
import { Button } from './button';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  size?: 'sm' | 'md';
  variant?: 'app' | 'agent';
}

export function CollapsibleSection({ title, defaultOpen = false, children, size = 'md', variant = 'app' }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const sizeClasses = size === 'sm'
    ? { button: 'py-2 px-3 text-ui-base', icon: '', content: 'px-3 pb-3 pt-1' }
    : { button: 'py-3 px-4 text-ui-base', icon: '', content: 'px-4 pb-4 pt-1' };

  const borderClass = variant === 'agent' ? 'border-muted-foreground' : 'border-border';

  return (
    <div className={`border-b ${borderClass} last:border-b-0`} data-testid={isOpen ? SECTION_EXPANDED_ID : SECTION_COLLAPSED_ID}>
      <Button
        variant="ghost"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between ${sizeClasses.button} font-normal text-muted-foreground hover:text-foreground`}
        data-testid={SECTION_HEADER_ID}
        data-expanded={isOpen}
      >
        <span>{title}</span>
        {isOpen ? (
          <ChevronDown className={sizeClasses.icon} data-testid={CHEVRON_DOWN_ID} />
        ) : (
          <ChevronRight className={sizeClasses.icon} data-testid={CHEVRON_RIGHT_ID} />
        )}
      </Button>
      {isOpen && (
        <div className={sizeClasses.content}>
          {children}
        </div>
      )}
    </div>
  );
}
