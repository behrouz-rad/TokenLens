import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
  /** Optional action rendered under the description, e.g. a "Clear filters" button. */
  children?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, className, children }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 p-8 text-center', className)}>
      <div className="rounded-lg bg-dt-bg-elevated p-3">
        <Icon size={24} className="text-dt-text-tertiary" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium text-dt-text-secondary">{title}</p>
        {description && <p className="mt-1 text-xs text-dt-text-tertiary">{description}</p>}
        {children}
      </div>
    </div>
  );
}
