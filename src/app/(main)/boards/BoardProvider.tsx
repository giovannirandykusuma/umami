'use client';
import { Loading, useToast } from '@umami/react-zen';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useApi } from '@/components/hooks/useApi';
import { useMessages } from '@/components/hooks/useMessages';
import { useModified } from '@/components/hooks/useModified';
import { useNavigation } from '@/components/hooks/useNavigation';
import { useBoardQuery } from '@/components/hooks/queries/useBoardQuery';
import { BOARD_TYPES, getBoardType } from '@/lib/boards';
import type { Board, BoardParameters } from '@/lib/types';
import { getComponentDefinition } from './boardComponentRegistry';

import { BoardContext, type LayoutGetter } from './BoardContext';

export { BoardContext, type BoardContextValue, type LayoutGetter } from './BoardContext';

const createDefaultBoard = (): Partial<Board> => ({
  type: BOARD_TYPES.mixed,
  name: '',
  description: '',
  parameters: {
    rows: [{ id: uuid(), columns: [{ id: uuid(), component: null }] }],
  },
});

function sanitizeBoardParameters(parameters?: BoardParameters): BoardParameters | undefined {
  if (!parameters?.rows) {
    return parameters;
  }

  return {
    ...parameters,
    rows: parameters.rows.map(row => ({
      ...row,
      columns: row.columns.map(column => {
        if (column.component && !getComponentDefinition(column.component.type)) {
          return {
            ...column,
            component: null,
          };
        }

        return column;
      }),
    })),
  };
}

export function BoardProvider({
  boardId,
  editing = false,
  children,
}: {
  boardId?: string;
  editing?: boolean;
  children: ReactNode;
}) {
  const { data, isFetching, isLoading } = useBoardQuery(boardId);
  const { post, useMutation } = useApi();
  const { touch } = useModified();
  const { toast } = useToast();
  const { t, labels, messages } = useMessages();
  const { router, renderUrl, teamId } = useNavigation();

  const [board, setBoard] = useState<Partial<Board>>(data ?? createDefaultBoard());
  const boardRef = useRef<Partial<Board>>(data ?? createDefaultBoard());
  const layoutGetterRef = useRef<LayoutGetter | null>(null);
  const aiCancelRef = useRef<(() => void) | null>(null);
  const aiPendingRef = useRef(false);
  const [aiPending, setPending] = useState(false);
  const setAiPending = useCallback((pending: boolean) => {
    aiPendingRef.current = pending;
    setPending(pending);
  }, []);
  const registerAiCancel = useCallback((cancel: (() => void) | null) => {
    aiCancelRef.current = cancel;
  }, []);

  const registerLayoutGetter = useCallback((getter: LayoutGetter) => {
    layoutGetterRef.current = getter;
  }, []);

  useEffect(() => {
    if (data) {
      aiCancelRef.current?.();
      const nextBoard = {
        ...data,
        type: getBoardType(data, { coerceDashboard: true }),
        parameters: sanitizeBoardParameters(data.parameters),
      };

      boardRef.current = nextBoard;
      setBoard(nextBoard);
    }
  }, [data]);

  const { mutateAsync, isPending } = useMutation({
    mutationFn: (boardData: Partial<Board>) => {
      if (boardData.id) {
        return post(`/boards/${boardData.id}`, boardData);
      }
      return post('/boards', {
        ...boardData,
        type: boardData.type || BOARD_TYPES.mixed,
        slug: '',
        teamId,
      });
    },
  });

  const updateBoard = useCallback((data: Partial<Board>) => {
    aiCancelRef.current?.();
    setBoard(current => {
      const nextBoard = { ...current, ...data };
      boardRef.current = nextBoard;

      return nextBoard;
    });
  }, []);

  const saveBoard = useCallback(async () => {
    if (aiPendingRef.current) throw new Error('Cancel AI assistance before saving.');
    const currentBoard = boardRef.current;
    const defaultName = t(labels.untitled);

    // Get current layout sizes from BoardEditBody if registered
    const layoutData = layoutGetterRef.current?.();
    const parameters = sanitizeBoardParameters(
      layoutData ? { ...currentBoard.parameters, ...layoutData } : currentBoard.parameters,
    );

    const result = await mutateAsync({
      ...currentBoard,
      name: currentBoard.name || defaultName,
      parameters,
    });

    toast(t(messages.saved));
    touch('boards');

    if (currentBoard.id) {
      touch(`board:${currentBoard.id}`);
    } else if (result?.id) {
      router.push(renderUrl(`/boards/${result.id}`));
    }

    return result;
  }, [mutateAsync, toast, t, labels.untitled, messages.saved, touch, router, renderUrl]);

  if (boardId && isFetching && isLoading) {
    return <Loading placement="absolute" />;
  }

  return (
    <BoardContext.Provider
      value={{
        board,
        editing,
        updateBoard,
        saveBoard,
        isPending,
        registerLayoutGetter,
        aiPending,
        setAiPending,
        registerAiCancel,
      }}
    >
      {children}
    </BoardContext.Provider>
  );
}
