'use client';
import { createContext, useContext } from 'react';

export const VerifierBoardContext = createContext<boolean>(false);
export function useVerifierBoard() {
  return useContext(VerifierBoardContext);
}
