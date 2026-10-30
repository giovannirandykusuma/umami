'use client';
import { createContext } from 'react';
import type { Board, BoardParameters } from '@/lib/types';

export type LayoutGetter = () => Partial<BoardParameters> | null;

export interface BoardContextValue {
  board: Partial<Board>;
  editing: boolean;
  updateBoard: (data: Partial<Board>) => void;
  saveBoard: () => Promise<Board>;
  isPending: boolean;
  registerLayoutGetter: (getter: LayoutGetter) => void;
  aiPending?: boolean;
  setAiPending?: (pending: boolean) => void;
  registerAiCancel?: (cancel: (() => void) | null) => void;
}

// Keep the context independent of BoardProvider's eager widget registry. Both the
// provider's public re-export and the shared hook must use this exact instance.
export const BoardContext = createContext<BoardContextValue>(null);
