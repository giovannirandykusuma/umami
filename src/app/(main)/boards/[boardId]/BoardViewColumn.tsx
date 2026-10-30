import { Column, Heading, Row, Text } from '@umami/react-zen';
import { type ReactNode, useMemo } from 'react';
import {
  useWebsiteStatsQuery,
  useFrozenWebsiteStatsReceipt,
} from '@/components/hooks/queries/useWebsiteStatsQuery';
import { useVerifierBoard } from '../VerifierBoardContext';
import { Empty } from '@/components/common/Empty';
import { Panel } from '@/components/common/Panel';
import { useBoard } from '@/components/hooks';
import { getBoardType, getResolvedComponentEntity, isOpenBoardType } from '@/lib/boards';
import type { BoardComponentConfig } from '@/lib/types';
import { BoardEntityBadge } from '../BoardEntityBadge';
import { getComponentDefinition } from '../boardComponentRegistry';
import { useBoardEntityAvailability } from '../useBoardEntityAvailability';
import { useBoardEntityBadgeProps } from '../useBoardEntityBadgeProps';
import { BoardComponentRenderer } from './BoardComponentRenderer';

function NativeReceipt({
  websiteId,
  compareMode,
  children,
}: {
  websiteId: string;
  compareMode?: boolean;
  children: ReactNode;
}) {
  const prepared = useFrozenWebsiteStatsReceipt(websiteId);
  const query = useWebsiteStatsQuery({ websiteId, compare: compareMode ? 'prev' : undefined });
  const state = query.error || !prepared ? 'failed' : query.data ? 'rendered' : 'loading';
  return (
    <section
      data-widget-id={prepared?.widgetId}
      data-analysis-state={state}
      data-execution-id={prepared?.executionId}
      data-definition-hash={prepared?.definitionHash}
      data-render-error={query.error ? JSON.stringify(query.error) : undefined}
    >
      {children}
    </section>
  );
}

export function BoardViewColumn({
  component,
  showEntityBadge = true,
  widgetId,
}: {
  component?: BoardComponentConfig;
  showEntityBadge?: boolean;
  /** Board column id; saved-analysis widgets key their query-backed render receipt by it. */
  widgetId?: string;
}) {
  const { board } = useBoard();
  const verifier = useVerifierBoard();
  const boardType = getBoardType(board);
  const definition = component ? getComponentDefinition(component.type) : undefined;
  const { entityType, entityId } = getResolvedComponentEntity(board, component);
  const entityBadge = useBoardEntityBadgeProps(entityType, entityId, showEntityBadge);
  const { isLoading, isUnavailable } = useBoardEntityAvailability(entityType, entityId);
  const config = useMemo(
    () =>
      component?.type === 'AnalysisWidget' && widgetId
        ? { ...component, props: { ...component.props, widgetId } }
        : component,
    [component, widgetId],
  );

  if (!component || (!entityId && definition?.requiresWebsite !== false)) {
    return null;
  }

  const title = component.title;
  const description = component.description;

  const showBadge = showEntityBadge && isOpenBoardType(boardType) && !!entityBadge;

  return (
    <Panel height="100%">
      {showBadge ? (
        <Row justifyContent={title ? 'space-between' : 'flex-end'} alignItems="center">
          {title && <Heading>{title}</Heading>}
          <BoardEntityBadge {...entityBadge} />
        </Row>
      ) : (
        title && <Heading>{title}</Heading>
      )}
      {description && <Text color="muted">{description}</Text>}
      <Column width="100%" height="100%" style={{ minHeight: 0 }}>
        <Column width="100%" flexGrow={1} style={{ minHeight: 0 }}>
          {!isLoading &&
            (isUnavailable ? (
              <Empty message="Selected item is no longer available." />
            ) : verifier && component.type === 'WebsiteMetricsBar' ? (
              <NativeReceipt websiteId={entityId!} compareMode={component.props?.compareMode}>
                <BoardComponentRenderer
                  config={config!}
                  websiteId={entityId}
                  entityType={entityType}
                />
              </NativeReceipt>
            ) : (
              <BoardComponentRenderer
                config={config!}
                websiteId={entityId}
                entityType={entityType}
              />
            ))}
        </Column>
      </Column>
    </Panel>
  );
}
