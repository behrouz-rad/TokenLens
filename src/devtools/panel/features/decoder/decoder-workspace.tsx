import { DecoderInput } from './decoder-input';
import { DecoderResult } from './decoder-result';

/**
 * Manual decoding workspace. Wide: the input on the left stays in view while the output scrolls
 * on the right. Narrow: input above output in one scrolling column.
 */
export function DecoderWorkspace({ narrow }: { narrow: boolean }) {
  if (narrow) {
    return (
      <div className="h-full overflow-y-auto overflow-x-hidden scrollbar-thin" tabIndex={0} aria-label="Decoder (scrollable)" data-testid="decoder-workspace" data-layout="narrow">
        <div className="border-b border-dt-border bg-dt-bg-secondary">
          <DecoderInput narrow />
        </div>
        <DecoderResult scrollable={false} />
      </div>
    );
  }
  return (
    <div className="flex h-full" data-testid="decoder-workspace" data-layout="wide">
      <div className="h-full w-[38%] min-w-[280px] max-w-[640px] shrink-0 border-r border-dt-border bg-dt-bg-secondary">
        <DecoderInput narrow={false} />
      </div>
      <div className="h-full min-w-0 flex-1">
        <DecoderResult scrollable />
      </div>
    </div>
  );
}
