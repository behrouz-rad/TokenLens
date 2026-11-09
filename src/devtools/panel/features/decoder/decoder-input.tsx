import { useId } from 'react';
import { Copy, Eraser } from 'lucide-react';
import { useDecoderStore } from '@/state/decoder-store';
import { normalizeCredentialInput } from '@/core/jwt/credential-input';
import { cn } from '@/lib/cn';
import { copyWithFeedback } from './copy-with-feedback';

const actionClass =
  'flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-2xs text-dt-text-tertiary transition-colors hover:bg-dt-bg-hover hover:text-dt-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-dt-text-tertiary';

/**
 * The editable token field. Spell checking and autocorrection are off: besides mangling a token,
 * a browser's enhanced spell check may send field contents to a remote service.
 */
export function DecoderInput({ narrow }: { narrow: boolean }) {
  const input = useDecoderStore((s) => s.input);
  const setInput = useDecoderStore((s) => s.setInput);
  const clearInput = useDecoderStore((s) => s.clearInput);
  const fieldId = useId();
  const hintId = useId();
  // Derived from the live input, not the debounced result, so Copy token never copies an earlier value.
  const credential = normalizeCredentialInput(input)?.credential ?? null;

  return (
    <section className={cn('flex min-h-0 flex-col', !narrow && 'h-full')} aria-labelledby={`${fieldId}-heading`} data-testid="decoder-input-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dt-border px-3 py-2">
        <h2 id={`${fieldId}-heading`} className="text-xs font-semibold text-dt-text">
          Token
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={actionClass}
            disabled={credential === null}
            onClick={() => {
              if (credential !== null) void copyWithFeedback(credential, 'Token copied (sensitive)');
            }}
            title="Copy the token without the Bearer prefix or surrounding whitespace (sensitive)"
          >
            <Copy size={12} aria-hidden />
            Copy token
          </button>
          <button type="button" className={actionClass} disabled={input.length === 0} onClick={clearInput} title="Clear the Decoder input. Captured data is not affected.">
            <Eraser size={12} aria-hidden />
            Clear input
          </button>
        </div>
      </div>
      <div className={cn('flex min-h-0 flex-col p-3', !narrow && 'flex-1')}>
        <label htmlFor={fieldId} className="sr-only">
          Token input
        </label>
        <textarea
          id={fieldId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-describedby={hintId}
          placeholder="Paste a JWT, with or without the Bearer prefix"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-testid="decoder-input"
          className={cn(
            'w-full resize-none break-all rounded border border-dt-border bg-dt-bg-tertiary p-2 font-mono text-[11px] leading-relaxed text-dt-text',
            'placeholder:text-dt-text-tertiary focus:border-dt-accent focus:outline-none scrollbar-thin',
            narrow ? 'h-36' : 'min-h-0 flex-1'
          )}
        />
        <p id={hintId} className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-2xs text-dt-text-tertiary">
          <span>Stays in this panel; not added to the capture session.</span>
          <span data-testid="decoder-input-length">{input.length.toLocaleString('en-US')} characters</span>
        </p>
      </div>
    </section>
  );
}
