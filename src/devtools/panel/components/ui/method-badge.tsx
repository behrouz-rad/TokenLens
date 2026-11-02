import { cn } from '@/lib/cn';
import type { HttpMethod } from '@/types';

const METHOD_STYLES: Record<string, string> = {
  GET: 'text-method-get',
  POST: 'text-method-post',
  PUT: 'text-method-put',
  DELETE: 'text-method-delete',
  PATCH: 'text-method-patch',
  HEAD: 'text-dt-text-secondary',
  OPTIONS: 'text-dt-text-secondary',
};

export function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-bold tracking-wider',
        'bg-dt-bg-elevated',
        METHOD_STYLES[method] ?? 'text-dt-text-secondary'
      )}
    >
      {method}
    </span>
  );
}
