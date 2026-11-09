import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import {
  columnSizingFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { RequestRow } from '@/hooks/use-request-explorer';
import { showTokenInOverview } from '@/state/capture-actions';
import { MethodBadge } from '../../components/ui/method-badge';
import { formatDuration, formatTimestamp, truncateUrl } from '@/lib/format';
import { cn } from '@/lib/cn';
import { httpStatusTone } from '@/lib/token-status';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

const features = tableFeatures({
  columnSizingFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic, alphanumeric: sortFn_alphanumeric },
});

const columnHelper = createColumnHelper<typeof features, RequestRow>();

export const REQUEST_ROW_HEIGHT = 28;

function buildColumns(showHost: boolean, showToken: boolean) {
  const base = [
    columnHelper.accessor((row) => row.request.startedAt, {
      id: 'startedAt',
      header: 'Time',
      size: 72,
      sortFn: 'basic',
      cell: ({ getValue }) => <span className="font-mono text-2xs text-dt-text-tertiary">{formatTimestamp(getValue())}</span>,
    }),
    columnHelper.accessor((row) => row.request.method, {
      id: 'method',
      header: 'Method',
      size: 72,
      sortFn: 'alphanumeric',
      cell: ({ getValue }) => <MethodBadge method={getValue()} />,
    }),
    columnHelper.accessor((row) => row.request.url, {
      id: 'url',
      header: 'URL',
      size: 260,
      sortFn: 'alphanumeric',
      cell: ({ getValue, row }) => (
        <span className="block truncate font-mono text-xs text-dt-text-secondary" title={getValue()}>
          {showHost && row.original.host && <span className="text-dt-text-tertiary">{row.original.host}</span>}
          {truncateUrl(getValue(), 80)}
        </span>
      ),
    }),
    columnHelper.accessor((row) => row.request.status, {
      id: 'status',
      header: 'Status',
      size: 110,
      sortFn: 'basic',
      cell: ({ getValue, row }) => (
        <span className={cn('font-mono text-xs', httpStatusTone(getValue()))} title={row.original.request.statusText}>
          {getValue() === 0 ? '-' : getValue()}
          {row.original.request.statusText && <span className="ml-1 text-2xs">{row.original.request.statusText}</span>}
        </span>
      ),
    }),
    columnHelper.accessor((row) => row.request.durationMs, {
      id: 'durationMs',
      header: 'Duration',
      size: 80,
      sortFn: 'basic',
      cell: ({ getValue }) => <span className="text-2xs text-dt-text-tertiary">{formatDuration(getValue())}</span>,
    }),
  ];
  if (!showToken) return columnHelper.columns(base);
  return columnHelper.columns([
    ...base,
    columnHelper.accessor((row) => (row.token ? `${row.token.name} #${row.token.sequenceNumber}` : ''), {
      id: 'token',
      header: 'Token',
      size: 150,
      sortFn: 'alphanumeric',
      cell: ({ row }) => {
        const token = row.original.token;
        if (!token) return <span className="text-2xs text-dt-text-tertiary">evicted</span>;
        return (
          <button
            type="button"
            onClick={() => showTokenInOverview(token.id)}
            aria-label={`Show ${token.name} #${token.sequenceNumber} in Overview`}
            title={`Show ${token.name} #${token.sequenceNumber} in Overview (${token.domain})`}
            className="max-w-full truncate rounded px-1 text-xs text-dt-accent hover:bg-dt-bg-hover hover:underline"
          >
            {token.name} <span className="font-mono text-2xs text-dt-text-tertiary">#{token.sequenceNumber}</span>
          </button>
        );
      },
    }),
  ]);
}

interface RequestGridProps {
  rows: RequestRow[];
  /** Prefix URLs with their host; useful when rows span several origins. */
  showHost?: boolean;
  /** Add a column linking each request to its token in the Overview. */
  showToken?: boolean;
  /** Request to scroll into view and highlight. */
  focusedId?: string | null;
  className?: string;
  style?: CSSProperties;
  ariaLabel: string;
}

/** Sortable, virtualised request table shared by the per-token view and the Requests explorer. */
export function RequestGrid({ rows, showHost = false, showToken = false, focusedId = null, className, style, ariaLabel }: RequestGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = useMemo(() => buildColumns(showHost, showToken), [showHost, showToken]);
  const table = useTable({ features, columns, data: rows, sortDescFirst: false }, (state) => ({ sorting: state.sorting }));
  const tableRows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => REQUEST_ROW_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    if (!focusedId) return;
    const index = tableRows.findIndex((row) => row.original.request.id === focusedId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
  }, [focusedId, tableRows, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows.length > 0 ? (virtualRows[0]?.start ?? 0) : 0;
  const paddingBottom = virtualRows.length > 0 ? virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0) : 0;

  return (
    <div ref={scrollRef} data-virtual-scroll tabIndex={0} aria-label={ariaLabel} className={cn('overflow-auto scrollbar-thin', className)} style={style}>
      <table className="w-full table-fixed text-xs">
        <thead className="sticky top-0 z-10 bg-dt-bg-secondary">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-dt-border">
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    style={{ width: header.getSize() }}
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                    className="px-3 py-1.5 text-left"
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider text-dt-text-tertiary hover:text-dt-text"
                    >
                      <table.FlexRender header={header} />
                      {sorted === 'asc' && <ArrowUp size={10} aria-hidden />}
                      {sorted === 'desc' && <ArrowDown size={10} aria-hidden />}
                      {!sorted && <ArrowUpDown size={10} className="opacity-30" aria-hidden />}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {paddingTop > 0 && (
            <tr aria-hidden>
              <td style={{ height: paddingTop }} colSpan={columns.length} />
            </tr>
          )}
          {virtualRows.map((virtualRow) => {
            const row = tableRows[virtualRow.index];
            if (!row) return null;
            const focused = row.original.request.id === focusedId;
            return (
              <tr
                key={row.id}
                data-testid="request-row"
                data-request-id={row.original.request.id}
                data-status={row.original.request.status}
                data-focused={focused || undefined}
                style={{ height: REQUEST_ROW_HEIGHT }}
                className={cn('border-b border-dt-border-subtle transition-colors hover:bg-dt-bg-hover', focused && 'bg-dt-accent/15')}
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="truncate px-3 py-1" style={{ width: cell.column.getSize() }}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden>
              <td style={{ height: paddingBottom }} colSpan={columns.length} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
