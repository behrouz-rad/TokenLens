/** One label/value pair of a token's metadata row; must be rendered inside a `<dl>`. */
export function Meta({ label, value, title, tone = 'neutral' }: { label: string; value: string | null; title?: string; tone?: 'neutral' | 'error' }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1" title={title ?? value ?? undefined}>
      <dt className="font-medium uppercase">{label}</dt>
      <dd className={tone === 'error' ? 'truncate text-dt-error' : 'truncate text-dt-text-secondary'}>{value ?? '-'}</dd>
    </div>
  );
}
