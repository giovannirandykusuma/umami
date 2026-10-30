import { useContext } from 'react';
import { BoardContext, type BoardContextValue } from '@/app/(main)/boards/BoardContext';

export function useBoard(): BoardContextValue {
  return useContext(BoardContext);
}
