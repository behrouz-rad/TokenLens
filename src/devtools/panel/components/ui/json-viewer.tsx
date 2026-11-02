import { memo, useState } from 'react';
import { cn } from '@/lib/cn';
import { ChevronRight, ChevronDown } from 'lucide-react';

/** Deeply nested claims are rendered to this depth; anything deeper is summarised instead of recursed. */
export const MAX_RENDER_DEPTH = 24;

interface JsonViewerProps {
  data: unknown;
  /** Depth up to which containers start expanded. Use Infinity to expand everything. */
  expandDepth?: number;
  className?: string;
}

export const JsonViewer = memo(function JsonViewer({ data, expandDepth = 2, className }: JsonViewerProps) {
  return (
    <div className={cn('font-mono text-[11px] leading-relaxed', className)} data-testid="json-viewer">
      <JsonNode key={String(expandDepth)} value={data} depth={0} expandDepth={expandDepth} />
    </div>
  );
});

interface JsonNodeProps {
  keyName?: string;
  value: unknown;
  depth: number;
  expandDepth: number;
  isLast?: boolean;
}

function KeyLabel({ keyName }: { keyName?: string }) {
  if (keyName === undefined) return null;
  return (
    <>
      <span className="text-(--json-key) break-all">&quot;{keyName}&quot;</span>
      <span className="text-dt-text-tertiary">: </span>
    </>
  );
}

function Trailer({ isLast }: { isLast: boolean }) {
  return isLast ? null : <span className="text-dt-text-tertiary">,</span>;
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-(--json-null)">null</span>;
  if (typeof value === 'boolean') return <span className="text-(--json-boolean)">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-(--json-number)">{Number.isFinite(value) ? value : String(value)}</span>;
  if (typeof value === 'string') return <span className="text-(--json-string) break-all whitespace-pre-wrap">&quot;{value}&quot;</span>;
  return <span className="text-dt-text-secondary">{typeof value === 'bigint' || typeof value === 'symbol' ? value.toString() : typeof value}</span>;
}

const JsonNode = memo(function JsonNode({ keyName, value, depth, expandDepth, isLast = true }: JsonNodeProps) {
  const isArray = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === 'object';
  const [expanded, setExpanded] = useState(depth < expandDepth);
  const indent = depth * 14;

  if (!isArray && !isObject) {
    return (
      <div style={{ paddingLeft: indent }} className="pl-4">
        <KeyLabel keyName={keyName} />
        <Primitive value={value} />
        <Trailer isLast={isLast} />
      </div>
    );
  }

  const entries: [string | undefined, unknown][] = isArray
    ? (value as unknown[]).map((item) => [undefined, item])
    : Object.entries(value as Record<string, unknown>);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  const summary = isArray ? `${entries.length} item${entries.length === 1 ? '' : 's'}` : `${entries.length} key${entries.length === 1 ? '' : 's'}`;

  if (entries.length === 0) {
    return (
      <div style={{ paddingLeft: indent }} className="pl-4">
        <KeyLabel keyName={keyName} />
        <span className="text-(--json-bracket)">{open + close}</span>
        <Trailer isLast={isLast} />
      </div>
    );
  }

  if (depth >= MAX_RENDER_DEPTH) {
    return (
      <div style={{ paddingLeft: indent }} className="pl-4">
        <KeyLabel keyName={keyName} />
        <span className="text-(--json-bracket)">{open}</span>
        <span className="text-dt-text-tertiary"> …{summary} (nesting too deep to display) </span>
        <span className="text-(--json-bracket)">{close}</span>
        <Trailer isLast={isLast} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ paddingLeft: indent }} className="flex items-start">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${keyName ?? (isArray ? 'array' : 'object')}`}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-dt-text-tertiary hover:bg-dt-bg-hover hover:text-dt-text"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="min-w-0">
          <KeyLabel keyName={keyName} />
          <span className="text-(--json-bracket)">{open}</span>
          {!expanded && (
            <>
              <span className="text-dt-text-tertiary"> …{summary} </span>
              <span className="text-(--json-bracket)">{close}</span>
              <Trailer isLast={isLast} />
            </>
          )}
        </span>
      </div>
      {expanded && (
        <>
          {entries.map(([childKey, childValue], i) => (
            <JsonNode
              key={childKey ?? i}
              keyName={childKey}
              value={childValue}
              depth={depth + 1}
              expandDepth={expandDepth}
              isLast={i === entries.length - 1}
            />
          ))}
          <div style={{ paddingLeft: indent }} className="pl-4">
            <span className="text-(--json-bracket)">{close}</span>
            <Trailer isLast={isLast} />
          </div>
        </>
      )}
    </div>
  );
});
