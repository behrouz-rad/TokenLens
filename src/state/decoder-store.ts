import { create } from 'zustand';
import { EMPTY_INSPECTION, inspectCredentialInput, type CredentialInspection } from '@/core/jwt/credential-input';

export const DECODE_DEBOUNCE_MS = 200;

export type DecodedView = 'pretty' | 'raw';
export type DecodedSection = 'header' | 'payload';

/**
 * State of the manual Decoder. It is deliberately separate from the capture store: pasted input
 * never becomes a Token, request or timeline event, never changes the selection, and is never
 * persisted. It lives as long as the panel document; DevTools recreating the panel frame resets it.
 */
interface DecoderStore {
  /** Exactly what the user typed or pasted. */
  input: string;
  /** The input the current `inspection` describes; differs from `input` while a decode is pending. */
  inspectedInput: string;
  inspection: CredentialInspection;
  views: Record<DecodedSection, DecodedView>;

  setInput: (input: string) => void;
  clearInput: () => void;
  setView: (section: DecodedSection, view: DecodedView) => void;
}

let pendingDecode: ReturnType<typeof setTimeout> | null = null;

function cancelPendingDecode(): void {
  if (pendingDecode !== null) {
    clearTimeout(pendingDecode);
    pendingDecode = null;
  }
}

const INITIAL_VIEWS: Record<DecodedSection, DecodedView> = { header: 'pretty', payload: 'pretty' };

export const useDecoderStore = create<DecoderStore>((set, get) => {
  const decodeNow = (input: string) => {
    cancelPendingDecode();
    set({ inspectedInput: input, inspection: inspectCredentialInput(input) });
  };

  return {
    input: '',
    inspectedInput: '',
    inspection: EMPTY_INSPECTION,
    views: INITIAL_VIEWS,

    setInput: (input) => {
      set({ input });
      // Emptying the field needs no parsing, and waiting would leave the old result on screen.
      if (input.trim().length === 0) {
        decodeNow(input);
        return;
      }
      cancelPendingDecode();
      pendingDecode = setTimeout(() => {
        pendingDecode = null;
        if (get().input === input) decodeNow(input);
      }, DECODE_DEBOUNCE_MS);
    },

    clearInput: () => {
      cancelPendingDecode();
      set({ input: '', inspectedInput: '', inspection: EMPTY_INSPECTION });
    },

    setView: (section, view) => set((state) => ({ views: { ...state.views, [section]: view } })),
  };
});

/** True while the visible result describes an earlier input than the one in the field. */
export function isDecoderResultStale(state: Pick<DecoderStore, 'input' | 'inspectedInput'>): boolean {
  return state.input !== state.inspectedInput;
}

export function resetDecoderStoreForTests(): void {
  cancelPendingDecode();
  useDecoderStore.setState({ input: '', inspectedInput: '', inspection: EMPTY_INSPECTION, views: INITIAL_VIEWS });
}
