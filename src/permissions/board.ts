import { hasPermission } from '@/lib/auth';
import { BOARD_ENTITY_TYPES, getBoardEntityIds, getResolvedComponentEntity } from '@/lib/boards';
import { PERMISSIONS } from '@/lib/constants';
import type { Auth, BoardComponentConfig, BoardParameters } from '@/lib/types';
import { isRendererCompatible } from '@/lib/analyst/definition';
import { getBoard, getReport, getTeamUser } from '@/queries/prisma';
import { getAnalysis } from '@/queries/prisma/analysis';
import { canViewAnalysis, isAnalysisVisibleOnBoard } from './analysis';
import { canViewLink } from './link';
import { canViewPixel } from './pixel';
import { canViewWebsite } from './website';

const BOARD_COMPONENT_REPORT_TYPES = {
  Funnel: 'funnel',
  Goal: 'goal',
} as const;

function getExpectedBoardReportType(componentType?: string) {
  return componentType && componentType in BOARD_COMPONENT_REPORT_TYPES
    ? BOARD_COMPONENT_REPORT_TYPES[componentType as keyof typeof BOARD_COMPONENT_REPORT_TYPES]
    : null;
}

async function isValidBoardReportReference(
  board: { type?: string; parameters?: BoardParameters },
  component: BoardComponentConfig,
  reportCache: Map<string, ReturnType<typeof getReport>>,
) {
  const expectedReportType = getExpectedBoardReportType(component.type);

  if (!expectedReportType) {
    return true;
  }

  const reportId = component.props?.reportId;

  if (reportId == null || reportId === '') {
    return true;
  }

  if (typeof reportId !== 'string') {
    return false;
  }

  const entity = getResolvedComponentEntity(board, component);

  if (entity.entityType !== BOARD_ENTITY_TYPES.website || !entity.entityId) {
    return false;
  }

  const reportPromise = reportCache.get(reportId) ?? getReport(reportId);
  reportCache.set(reportId, reportPromise);

  const report = await reportPromise;

  return !!report && report.type === expectedReportType && report.websiteId === entity.entityId;
}

async function checkBoardEntityAccess(check: Promise<boolean>) {
  try {
    return await check;
  } catch {
    return false;
  }
}

export async function canViewBoardEntities(
  auth: Auth,
  type: string | undefined,
  parameters: BoardParameters = {},
) {
  const { websiteIds, pixelIds, linkIds } = getBoardEntityIds({ type, parameters });
  const userOnlyAuth: Auth = { user: auth.user };
  const checks = [
    ...websiteIds.map(id => checkBoardEntityAccess(canViewWebsite(userOnlyAuth, id))),
    ...pixelIds.map(id => checkBoardEntityAccess(canViewPixel(userOnlyAuth, id))),
    ...linkIds.map(id => checkBoardEntityAccess(canViewLink(userOnlyAuth, id))),
  ];

  const results = await Promise.all(checks);

  return results.every(Boolean);
}

export async function hasValidBoardReports(
  type: string | undefined,
  parameters: BoardParameters = {},
) {
  const board = { type, parameters };
  const reportCache = new Map<string, ReturnType<typeof getReport>>();

  for (const row of parameters.rows ?? []) {
    for (const column of row.columns ?? []) {
      const component = column.component;
      if (!component) {
        continue;
      }

      if (!(await isValidBoardReportReference(board, component, reportCache))) {
        return false;
      }
    }
  }

  return true;
}

export async function stripInvalidBoardReports(
  type: string | undefined,
  parameters: BoardParameters = {},
) {
  const board = { type, parameters };
  const reportCache = new Map<string, ReturnType<typeof getReport>>();
  let hasChanges = false;

  const rows = await Promise.all(
    (parameters.rows ?? []).map(async row => {
      const columns = await Promise.all(
        row.columns.map(async column => {
          const component = column.component;

          if (!component || (await isValidBoardReportReference(board, component, reportCache))) {
            return column;
          }

          hasChanges = true;

          const { reportId: _reportId, ...nextProps } = component.props ?? {};

          return {
            ...column,
            component: {
              ...component,
              props: Object.keys(nextProps).length > 0 ? nextProps : undefined,
            },
          };
        }),
      );

      return {
        ...row,
        columns,
      };
    }),
  );

  if (!hasChanges) {
    return parameters;
  }

  return {
    ...parameters,
    rows,
  };
}

export async function canViewBoard({ user, shareToken }: Auth, boardId: string) {
  if (user?.isAdmin) {
    return true;
  }

  if (shareToken?.boardId === boardId) {
    return true;
  }

  if (!user) {
    return false;
  }

  const board = await getBoard(boardId);

  if (!board) {
    return false;
  }

  if (board.userId) {
    return user.id === board.userId;
  }

  if (board.teamId) {
    const teamUser = await getTeamUser(board.teamId, user.id);

    return !!teamUser;
  }

  return false;
}

export async function canUpdateBoard({ user }: Auth, boardId: string) {
  if (!user) {
    return false;
  }

  if (user.isAdmin) {
    return true;
  }

  const board = await getBoard(boardId);

  if (!board) {
    return false;
  }

  if (board.userId) {
    return user.id === board.userId;
  }

  if (board.teamId) {
    const teamUser = await getTeamUser(board.teamId, user.id);

    return teamUser && hasPermission(teamUser.role, PERMISSIONS.websiteUpdate);
  }

  return false;
}

export async function canDeleteBoard({ user }: Auth, boardId: string) {
  if (!user) {
    return false;
  }

  if (user.isAdmin) {
    return true;
  }

  const board = await getBoard(boardId);

  if (!board) {
    return false;
  }

  if (board.userId) {
    return user.id === board.userId;
  }

  if (board.teamId) {
    const teamUser = await getTeamUser(board.teamId, user.id);

    return teamUser && hasPermission(teamUser.role, PERMISSIONS.websiteDelete);
  }

  return false;
}

export const ANALYSIS_WIDGET = 'AnalysisWidget';

/** Every AnalysisWidget component in board order. */
export function getAnalysisWidgets(parameters: BoardParameters = {}) {
  return (parameters.rows ?? []).flatMap(row =>
    (row.columns ?? [])
      .map(column => column.component)
      .filter(component => component?.type === ANALYSIS_WIDGET),
  );
}

/**
 * Validates AnalysisWidget references for a board owned by `owner`: strict config, viewer access,
 * no exposure of a more restricted analysis, and renderer compatibility. Null when valid.
 */
export async function getInvalidBoardAnalysis(
  auth: Auth,
  owner: { userId: string | null; teamId: string | null },
  parameters: BoardParameters = {},
): Promise<string | null> {
  for (const component of getAnalysisWidgets(parameters)) {
    const props = component.props ?? {};
    const allowed = ['analysisId', 'title', 'visualization'];
    if (Object.keys(props).some(key => !allowed.includes(key))) return 'Invalid analysis widget.';
    if (typeof props.analysisId !== 'string') return 'Invalid analysis widget.';
    if (props.title !== undefined && (typeof props.title !== 'string' || props.title.length > 200))
      return 'Invalid analysis widget.';
    const analysis = await getAnalysis(props.analysisId);
    if (!analysis || !(await canViewAnalysis(auth, analysis))) return 'Analysis is not accessible.';
    if (!isAnalysisVisibleOnBoard(owner, analysis))
      return 'Analysis visibility is narrower than the board.';
    // Current source authority, not only access to the saved record (revocation denies save).
    const websiteId = (analysis.definition as any)?.source?.websiteId;
    if (typeof websiteId !== 'string' || !(await canViewWebsite(auth, websiteId)))
      return 'Analysis source is not accessible.';
    if (!isRendererCompatible((analysis.definition as any)?.operation, String(props.visualization)))
      return 'Visualization is incompatible with the analysis.';
  }
  return null;
}
