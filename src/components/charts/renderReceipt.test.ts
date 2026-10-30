import { expect, it } from 'vitest';
import { queryRenderState, receiptAttributes } from './renderReceipt';

it('state derives from the query result only', () => {
  expect(queryRenderState({ isLoading: true })).toBe('loading');
  expect(queryRenderState({ data: undefined })).toBe('loading');
  expect(queryRenderState({ error: { status: 403 } })).toBe('denied');
  expect(queryRenderState({ error: { code: 'unsupported' } })).toBe('unsupported');
  expect(queryRenderState({ error: { code: 'execution_failed' }, data: { rows: [1] } })).toBe(
    'error',
  );
  expect(queryRenderState({ data: { rows: [] }, isEmpty: d => !d.rows.length })).toBe('empty');
  expect(queryRenderState({ data: { rows: [1] }, isEmpty: d => !d.rows.length })).toBe('rendered');
});

it('attributes carry execution/hash only when the query returned them', () => {
  expect(receiptAttributes()).toEqual({});
  expect(receiptAttributes({ state: 'error' })).toEqual({ 'data-analysis-state': 'error' });
  expect(receiptAttributes({ state: 'rendered', executionId: 'e', definitionHash: 'h' })).toEqual({
    'data-analysis-state': 'rendered',
    'data-execution-id': 'e',
    'data-definition-hash': 'h',
  });
});
