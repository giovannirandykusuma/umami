import { expect, test } from 'vitest';
import { getComponentDefinition } from '@/app/(main)/boards/boardComponentRegistry';
import {
  BOARD_COMPONENT_COMPATIBILITY_MATRIX,
  getSupportedBoardComponentEntityTypes,
} from './boardComponentCompatibility';
import { BOARD_ENTITY_TYPES, getBoardEntityIds, isBoardComponentSupported } from './boards';

test('comparison websites are included in board permission checks for every board type', () => {
  for (const type of ['dashboard', 'mixed', 'website', 'pixel', 'link']) {
    const board = {
      type,
      parameters: {
        websiteId: 'root',
        pixelId: 'pixel',
        linkId: 'link',
        rows: [
          {
            id: 'row',
            columns: [
              {
                id: 'column',
                component: {
                  type: 'WebsiteCompareChart',
                  props: { websiteIds: ['first', 'second', 'root'] },
                },
              },
            ],
          },
        ],
      },
    };
    expect(getBoardEntityIds(board)).toEqual({
      websiteIds: ['root', 'first', 'second'],
      pixelIds: ['pixel'],
      linkIds: ['link'],
    });
    expect(isBoardComponentSupported('WebsiteCompareChart', type as any)).toBe(true);
  }
  expect(getComponentDefinition('WebsiteCompareChart')?.requiresWebsite).toBe(false);
  expect(
    getComponentDefinition('WebsiteCompareChart')?.configFields?.find(
      field => field.name === 'websiteIds',
    )?.type,
  ).toBe('websites');
});

test('isBoardComponentSupported allows events chart on website boards', () => {
  expect(isBoardComponentSupported('EventsChart', BOARD_ENTITY_TYPES.website)).toBe(true);
});

test('isBoardComponentSupported rejects events chart on pixel and link boards', () => {
  expect(isBoardComponentSupported('EventsChart', BOARD_ENTITY_TYPES.pixel)).toBe(false);
  expect(isBoardComponentSupported('EventsChart', BOARD_ENTITY_TYPES.link)).toBe(false);
});

test('isBoardComponentSupported rejects event metrics bar and weekly traffic on pixel and link boards', () => {
  expect(isBoardComponentSupported('EventsMetricsBar', BOARD_ENTITY_TYPES.pixel)).toBe(false);
  expect(isBoardComponentSupported('EventsMetricsBar', BOARD_ENTITY_TYPES.link)).toBe(false);
  expect(isBoardComponentSupported('WeeklyTraffic', BOARD_ENTITY_TYPES.pixel)).toBe(false);
  expect(isBoardComponentSupported('WeeklyTraffic', BOARD_ENTITY_TYPES.link)).toBe(false);
});

test('board component compatibility matrix defines website-only components explicitly', () => {
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.EventsMetricsBar).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.EventsChart).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.Funnel).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.Goal).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RealtimeActiveUsers).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RealtimeHeader).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RealtimeChart).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RevenueMetricsBar).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RevenueChart).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.RevenueMetricsTable).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.UTM).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(BOARD_COMPONENT_COMPATIBILITY_MATRIX.WeeklyTraffic).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(getSupportedBoardComponentEntityTypes('EventsMetricsBar')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('EventsChart')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('Funnel')).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(getSupportedBoardComponentEntityTypes('Goal')).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(getSupportedBoardComponentEntityTypes('RealtimeActiveUsers')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('RealtimeHeader')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('RealtimeChart')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('RevenueMetricsBar')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('RevenueChart')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('RevenueMetricsTable')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
  expect(getSupportedBoardComponentEntityTypes('UTM')).toEqual([BOARD_ENTITY_TYPES.website]);
  expect(getSupportedBoardComponentEntityTypes('WeeklyTraffic')).toEqual([
    BOARD_ENTITY_TYPES.website,
  ]);
});

test('isBoardComponentSupported leaves other components available for all board entities', () => {
  expect(isBoardComponentSupported('WebsiteChart', BOARD_ENTITY_TYPES.pixel)).toBe(true);
  expect(isBoardComponentSupported('TextBlock', BOARD_ENTITY_TYPES.link)).toBe(true);
});

test('metrics table limits pixel and link boards to overview-page metric types', () => {
  const definition = getComponentDefinition('MetricsTable');
  const options = definition?.configFields?.find(
    field => field.name === 'type',
  )?.optionsByEntityType;

  expect(options?.pixel?.map(option => option.value)).toEqual([
    'referrer',
    'channel',
    'country',
    'region',
    'city',
    'browser',
    'os',
    'device',
  ]);
  expect(options?.link?.map(option => option.value)).toEqual([
    'referrer',
    'channel',
    'country',
    'region',
    'city',
    'browser',
    'os',
    'device',
  ]);
});
