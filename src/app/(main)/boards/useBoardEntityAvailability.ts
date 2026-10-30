import { useLinkQuery, usePixelQuery, useWebsiteQuery } from '@/components/hooks';
import type { BoardEntityType } from '@/lib/boards';
import { useVerifierBoard } from './VerifierBoardContext';

export function useBoardEntityAvailability(entityType?: BoardEntityType, entityId?: string) {
  const frozen = useVerifierBoard();
  const websiteQuery = useWebsiteQuery(!frozen && entityType === 'website' ? entityId : undefined);
  const pixelQuery = usePixelQuery(!frozen && entityType === 'pixel' ? entityId : undefined);
  const linkQuery = useLinkQuery(!frozen && entityType === 'link' ? entityId : undefined);
  const query =
    entityType === 'website' ? websiteQuery : entityType === 'pixel' ? pixelQuery : linkQuery;

  if (frozen || !entityId) {
    return { isLoading: false, isUnavailable: false };
  }

  const status = (query.error as { status?: number } | null)?.status;

  return {
    isLoading: query.isLoading,
    isUnavailable: status === 401 || status === 404,
  };
}
