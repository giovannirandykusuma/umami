import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardComponentSelect } from './BoardComponentSelect';

vi.mock('@/components/hooks', () => ({
  useMessages: () => ({ t: (value: string) => value, labels: { save: 'Save' }, messages: {} }),
  useApi: () => ({ get: vi.fn(), useQuery: () => ({}) }),
}));
vi.mock('@/components/hooks/useModified', () => ({ useModified: () => ({}) }));
vi.mock('./BoardComponentRenderer', () => ({ BoardComponentRenderer: () => null }));
vi.mock('@/components/input/WebsiteSelect', () => ({
  WebsiteSelect: ({ websiteId, onChange }: any) => (
    <select aria-label="Website" value={websiteId} onChange={e => onChange(e.target.value)}>
      <option value="">Choose</option>
      <option value="11111111-1111-1111-1111-111111111111">First website</option>
      <option value="22222222-2222-2222-2222-222222222222">Second website</option>
    </select>
  ),
}));
vi.mock('@/components/input/PixelSelect', () => ({ PixelSelect: () => null }));
vi.mock('@/components/input/LinkSelect', () => ({ LinkSelect: () => null }));
vi.mock('@/app/(main)/boards/boardComponentRegistry', () => {
  const def = {
    icon: () => null,
    type: 'WebsiteCompareChart',
    name: 'Comparison',
    requiresWebsite: false,
    defaultProps: { websiteIds: [], metric: 'visitors' },
    configFields: [{ name: 'websiteIds', label: 'Websites', type: 'websites', required: true }],
  };
  return { getComponentDefinitions: () => [def] };
});
vi.mock('@umami/react-zen', () => ({
  Column: ({ children }: any) => <div>{children}</div>,
  Row: ({ children }: any) => <div>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  TextField: ({ value, onChange }: any) => (
    <input value={value} onChange={e => onChange(e.target.value)} />
  ),
  Button: ({ children, onPress, isDisabled }: any) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
  Select: ({ children }: any) => <div>{children}</div>,
  ListItem: ({ children }: any) => <div>{children}</div>,
}));
afterEach(cleanup);

it('requires 2–10 unique website IDs before saving and preserves the array without an entity', () => {
  const onSelect = vi.fn();
  render(
    <BoardComponentSelect
      boardType="pixel"
      boardEntityType="pixel"
      boardEntityId="pixel"
      initialConfig={{ type: 'WebsiteCompareChart', props: { websiteIds: [], metric: 'visitors' } }}
      onSelect={onSelect}
      onClose={vi.fn()}
    />,
  );
  const save = screen.getByText('Save') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByText('Add website'));
  fireEvent.change(screen.getAllByLabelText('Website')[0], {
    target: { value: '11111111-1111-1111-1111-111111111111' },
  });
  expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByText('Add website'));
  fireEvent.change(screen.getAllByLabelText('Website')[1], {
    target: { value: '11111111-1111-1111-1111-111111111111' },
  });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getAllByLabelText('Website')[1], {
    target: { value: '22222222-2222-2222-2222-222222222222' },
  });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(onSelect.mock.lastCall![0]).toMatchObject({
    type: 'WebsiteCompareChart',
    props: {
      websiteIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
    },
  });
  expect(onSelect.mock.lastCall![0]).not.toHaveProperty('entityId');
  for (let i = 0; i < 8; i++) fireEvent.click(screen.getByText('Add website'));
  expect((screen.getByText('Add website') as HTMLButtonElement).disabled).toBe(true);
  expect(save.disabled).toBe(true);
});
