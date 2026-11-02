import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  size?: number;
  label: string;
  active?: boolean;
  badge?: number;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, size = 16, label, active, badge, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative inline-flex items-center justify-center rounded p-1.5 transition-colors',
        'text-dt-text-secondary hover:bg-dt-bg-hover hover:text-dt-text',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active && 'bg-dt-bg-active text-dt-accent',
        className
      )}
      {...props}
    >
      <Icon size={size} />
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-dt-accent px-1 text-center text-[9px] font-semibold leading-3.5 text-dt-bg">
          {badge}
        </span>
      )}
    </button>
  );
});
