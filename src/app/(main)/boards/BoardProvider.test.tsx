import { act, render, screen } from '@testing-library/react';
import { useContext } from 'react';
import { useBoard } from '@/components/hooks/context/useBoard';
import { BoardContext as SharedBoardContext } from './BoardContext';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardContext, BoardProvider, type BoardContextValue } from './BoardProvider';

const mocks = vi.hoisted(() => ({
  post: vi.fn(async (_url: string, board: unknown) => board),
  push: vi.fn(),
  touch: vi.fn(),
  toast: vi.fn(),
  data: { id: 'existing-board', name: 'Manual board', type: 'mixed', parameters: { rows: [] } },
}));
vi.mock('@umami/react-zen', () => ({
  Loading: () => null,
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@/components/hooks/queries/useBoardQuery', () => ({
  useBoardQuery: () => ({ data: mocks.data }),
}));
vi.mock('./boardComponentRegistry', () => ({ getComponentDefinition: () => ({}) }));
vi.mock('@/components/hooks/useApi', () => ({
  useApi: () => ({
    post: mocks.post,
    useMutation: ({ mutationFn }: any) => ({ mutateAsync: mutationFn, isPending: false }),
  }),
}));
vi.mock('@/components/hooks/useModified', () => ({
  useModified: () => ({ touch: mocks.touch }),
}));
vi.mock('@/components/hooks/useMessages', () => ({
  useMessages: () => ({
    t: (s: string) => s,
    labels: { untitled: 'Untitled' },
    messages: { saved: 'Saved' },
  }),
}));
vi.mock('@/components/hooks/useNavigation', () => ({
  useNavigation: () => ({ router: { push: mocks.push }, renderUrl: (s: string) => s }),
}));
let context: BoardContextValue;
function Probe() {
  context = useContext(BoardContext);
  expect(BoardContext).toBe(SharedBoardContext);
  expect(useBoard()).toBe(context);
  return <span>{context.board.name}</span>;
}
beforeEach(() => vi.clearAllMocks());
describe('BoardProvider local draft boundary', () => {
  it('does not persist local preview updates; only explicit save posts merged parameters', async () => {
    render(
      <BoardProvider boardId="existing-board" editing>
        <Probe />
      </BoardProvider>,
    );
    const parameters = {
      rows: [
        {
          id: 'row',
          columns: [{ id: 'col', component: { type: 'TextBlock', props: { text: 'Preview' } } }],
        },
      ],
    };
    act(() => context.updateBoard({ parameters }));
    expect(screen.getByText('Manual board')).toBeVisible();
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => {
      await context.saveBoard();
    });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      '/boards/existing-board',
      expect.objectContaining({ parameters }),
    );
  });
  it('cancels pending work synchronously before manual updates and blocks Save while pending', async () => {
    render(
      <BoardProvider boardId="existing-board" editing>
        <Probe />
      </BoardProvider>,
    );
    const cancel = vi.fn();
    act(() => {
      context.registerAiCancel(cancel);
      context.setAiPending(true);
    });
    await expect(context.saveBoard()).rejects.toThrow('Cancel AI assistance before saving.');
    expect(mocks.post).not.toHaveBeenCalled();
    act(() => context.updateBoard({ name: 'Manual edit' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(screen.getByText('Manual edit')).toBeVisible();
  });
});
