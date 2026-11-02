import * as RadixPopover from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

interface PopoverProps {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ trigger, title, children, className, open, onOpenChange }: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-50 w-72 max-w-[calc(100vw-16px)] rounded-lg border border-dt-border bg-dt-bg-elevated p-3 text-xs text-dt-text shadow-xl',
            'animate-slide-in focus:outline-none',
            className
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold">{title}</h2>
            <RadixPopover.Close
              aria-label={`Close ${title.toLowerCase()}`}
              className="rounded p-0.5 text-dt-text-tertiary hover:bg-dt-bg-hover hover:text-dt-text"
            >
              <X size={12} />
            </RadixPopover.Close>
          </div>
          {children}
          <RadixPopover.Arrow className="fill-dt-border" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
