import { Type } from '@sinclair/typebox';

export const names = [
  'umami_api',
  'ask_user',
  'show_chart',
  'open_link',
  'analytics_schema',
  'find_people',
  'query_series',
  'query_breakdown',
  'query_totals',
];
export const analystNames = [
  'analyst_discover',
  'analyst_preview',
  'analyst_plan_board',
  'analyst_commit_draft',
  'analyst_readback',
  'analyst_verify_render',
  'analyst_record_inspection',
  'analyst_request_change',
];
const IMAGE_MIMES = ['image/png', 'image/jpeg'];
// Decoded 1 MiB per image, at most 6 images, base64-only data (spec §4.2).
const MAX_IMAGE_BASE64 = Math.ceil((1024 * 1024) / 3) * 4;

/** Converts the host's dedicated image envelope into Pi content blocks; base64 never goes to text. */
export function imageContent(name, value) {
  let envelope;
  try {
    envelope = JSON.parse(value);
  } catch {
    return null;
  }
  if (!envelope || envelope.umamiImageEnvelope !== 1) return null;
  if (
    name !== 'analyst_verify_render' ||
    typeof envelope.text !== 'string' ||
    !Array.isArray(envelope.images) ||
    envelope.images.length > 6 ||
    envelope.images.some(
      i =>
        !i ||
        !IMAGE_MIMES.includes(i.mimeType) ||
        typeof i.data !== 'string' ||
        !i.data ||
        i.data.length > MAX_IMAGE_BASE64 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(i.data),
    )
  )
    throw new Error('Invalid host image result');
  return [
    { type: 'text', text: envelope.text },
    ...envelope.images.map(i => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
  ];
}

export default function (pi) {
  const analyst = process.env.AI_ANALYST_ENABLED === 'true';
  const active = analyst ? [...names, ...analystNames] : names;
  const string = () => Type.String({ maxLength: 4000 });
  const optional = schema => Type.Optional(schema);
  const enumeration = values => Type.Union(values.map(Type.Literal));
  const range = {
    websiteId: Type.String({ format: 'uuid' }),
    startAt: Type.Integer({ minimum: 0 }),
    endAt: Type.Integer({ minimum: 0 }),
  };
  const property = Type.Object(
    {
      name: string(),
      op: enumeration([
        'eq',
        'neq',
        's',
        'ns',
        'c',
        'dnc',
        're',
        'nre',
        't',
        'f',
        'gt',
        'gte',
        'lt',
        'lte',
        'bf',
        'af',
      ]),
      value: string(),
      type: Type.Integer({ minimum: 1, maximum: 5 }),
    },
    { additionalProperties: false },
  );
  const filters = Type.Object(
    {
      ...Object.fromEntries(
        [
          'path',
          'referrer',
          'title',
          'query',
          'os',
          'browser',
          'device',
          'country',
          'region',
          'city',
          'tag',
          'hostname',
          'distinctId',
          'language',
          'event',
          'utmSource',
          'utmMedium',
          'utmCampaign',
          'utmContent',
          'utmTerm',
          'segment',
          'cohort',
          'excludeBounce',
        ].map(key => [key, optional(string())]),
      ),
      eventType: optional(Type.Integer({ minimum: 1 })),
      match: optional(enumeration(['all', 'any'])),
      eventProperty: optional(Type.Array(property, { maxItems: 20 })),
      sessionProperty: optional(Type.Array(property, { maxItems: 20 })),
    },
    { additionalProperties: false },
  );
  const strict = (props, options = {}) =>
    Type.Object(props, { ...options, additionalProperties: false });
  const parameters = {
    analytics_schema: strict(range),
    find_people: strict({
      ...range,
      search: Type.String({ minLength: 2, maxLength: 100 }),
      property: optional(string()),
    }),
    query_series: strict({
      ...range,
      metric: enumeration(['pageviews', 'visitors', 'events']),
      unit: enumeration(['hour', 'day', 'month']),
      timezone: string(),
      filters: optional(filters),
    }),
    query_breakdown: strict({
      ...range,
      dimension: enumeration([
        'path',
        'title',
        'referrer',
        'browser',
        'os',
        'device',
        'country',
        'region',
        'city',
        'language',
        'hostname',
        'event',
        'channel',
        'utmSource',
        'utmMedium',
        'utmCampaign',
        'utmContent',
        'utmTerm',
      ]),
      limit: optional(Type.Integer({ minimum: 1, maximum: 50 })),
      filters: optional(filters),
    }),
    query_totals: strict(range),
    umami_api: Type.Object({
      method: Type.Union(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(Type.Literal)),
      path: string(),
      query: optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
      ),
      body: optional(Type.Unknown()),
    }),
    ask_user: Type.Object({
      question: string(),
      options: optional(Type.Array(string(), { maxItems: 20 })),
      allowText: optional(Type.Boolean()),
    }),
    show_chart: Type.Union([
      strict({
        resultId: string(),
        kind: enumeration(['line', 'bar', 'table']),
        title: optional(string()),
      }),
      strict({
        title: optional(string()),
        component: Type.Union([
          strict({
            type: Type.Literal('WebsiteCompareChart'),
            props: strict({
              websiteIds: Type.Array(Type.String({ format: 'uuid' }), {
                minItems: 2,
                maxItems: 10,
              }),
              metric: enumeration(['visitors', 'pageviews']),
              unit: optional(enumeration(['hour', 'day', 'month'])),
              startAt: optional(Type.Integer()),
              endAt: optional(Type.Integer()),
            }),
          }),
          ...['WebsiteChart', 'WebsiteMetricsBar', 'WorldMap'].map(type =>
            strict({
              type: Type.Literal(type),
              websiteId: Type.String({ format: 'uuid' }),
              props: optional(strict({})),
            }),
          ),
          strict({
            type: Type.Literal('MetricsTable'),
            websiteId: Type.String({ format: 'uuid' }),
            props: strict({
              type: enumeration([
                'path',
                'referrer',
                'browser',
                'os',
                'device',
                'country',
                'event',
              ]),
              limit: optional(enumeration([5, 10, 20])),
            }),
          }),
        ]),
      }),
    ]),
    open_link: Type.Object({ label: string(), href: string() }),
  };
  // Host re-validates every field strictly; these schemas only keep calls well-formed. No
  // taskId, principal, URL, capability or credential field exists in any analyst schema.
  const uuid = Type.String({ format: 'uuid' });
  // Mirrors src/lib/analyst/definition.ts definitionSchema exactly (host still re-validates).
  const dims = [
    'path',
    'title',
    'referrer',
    'query',
    'hostname',
    'tag',
    'utmSource',
    'utmMedium',
    'utmCampaign',
    'utmContent',
    'utmTerm',
    'browser',
    'os',
    'device',
    'country',
    'region',
    'city',
    'language',
  ];
  const owner = enumeration(['event', 'session']);
  const definition = strict(
    {
      schemaVersion: Type.Literal(1),
      source: strict({ websiteId: uuid }),
      operation: enumeration(['series', 'breakdown', 'totals', 'numeric_property']),
      metric: Type.String({
        description:
          'series: pageviews|sessions|events; breakdown: sessions|events; totals: pageviews|visits|sessions|events|identified_users; numeric_property: sum|average|median|min|max|count',
      }),
      event: optional(
        Type.String({ description: 'Exact custom event name; required only for metric events' }),
      ),
      filters: optional(
        Type.Array(
          strict({
            dimension: enumeration([...dims, 'distinctId']),
            operator: enumeration(['eq', 'neq', 'c', 'dnc']),
            values: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }),
          }),
          { maxItems: 20 },
        ),
      ),
      propertyFilters: optional(
        Type.Array(
          strict({
            owner,
            name: string(),
            dataType: enumeration([1, 2, 4]),
            operator: enumeration(['eq', 'neq', 'c', 'dnc', 'gt', 'gte', 'lt', 'lte', 'bf', 'af']),
            value: string(),
          }),
          { maxItems: 20 },
        ),
      ),
      groupBy: optional(
        strict({
          dimension: enumeration(dims),
          top: optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
      ),
      unit: optional(enumeration(['hour', 'day', 'month'])),
      property: optional(strict({ owner, name: string() })),
      datePolicy: Type.Union([
        strict({
          type: Type.Literal('fixed'),
          startAt: Type.Integer({ minimum: 0 }),
          endAt: Type.Integer({ minimum: 1, description: 'Exclusive end, Unix ms' }),
        }),
        strict({
          type: Type.Literal('rolling'),
          window: enumeration(['today', '24h', '7d', '30d', '90d']),
        }),
      ]),
      timezone: Type.String({ description: 'IANA timezone, e.g. UTC' }),
      semanticBinding: strict({
        label: string(),
        unit: string(),
        population: string(),
        meaningSource: enumeration(['user_confirmed', 'repository_definition', 'observed_only']),
      }),
    },
    {
      description:
        'unit is required for series and forbidden otherwise; groupBy only for breakdown. No visualization field (that is a widget prop).',
    },
  );
  const widget = strict({
    id: Type.String({ maxLength: 64, description: 'Stable widget id; repair names this id' }),
    size: optional(Type.Number()),
    component: strict({
      type: Type.Literal('AnalysisWidget'),
      props: Type.Union([
        strict({
          analysisRef: Type.String({ description: 'ref of an analysis in this bundle' }),
          visualization: enumeration(['line', 'bar', 'table', 'metric']),
          title: optional(string()),
        }),
        strict({
          analysisId: Type.String({
            format: 'uuid',
            description: 'Already committed analysis id (keep it to revise a stable widget)',
          }),
          visualization: enumeration(['line', 'bar', 'table', 'metric']),
          title: optional(string()),
        }),
      ]),
    }),
  });
  const bundle = {
    boardId: optional(uuid),
    expectedRevision: optional(Type.Integer({ minimum: 1 })),
    board: strict({
      type: Type.Literal('mixed'),
      name: string(),
      description: optional(string()),
      parameters: strict({
        rows: Type.Array(
          strict({
            id: string(),
            size: optional(Type.Number()),
            columns: Type.Array(widget, { maxItems: 12 }),
          }),
        ),
      }),
    }),
    analyses: Type.Array(
      strict({
        ref: string(),
        name: string(),
        description: optional(string()),
        definition,
      }),
      { maxItems: 12 },
    ),
  };
  const repair = strict({
    widgetId: Type.String({
      maxLength: 64,
      description: 'id of a committed widget of this draft whose definition or props change',
    }),
    reason: Type.String({ maxLength: 300 }),
  });
  Object.assign(parameters, {
    analyst_discover: strict({ websiteId: optional(uuid) }),
    analyst_preview: strict({ definition }),
    analyst_plan_board: strict(bundle),
    analyst_commit_draft: strict({ ...bundle, operationKey: string(), repair: optional(repair) }),
    analyst_readback: strict({ boardId: uuid }),
    analyst_verify_render: strict({ boardId: uuid, rerender: optional(Type.Boolean()) }),
    analyst_record_inspection: strict({
      receiptId: uuid,
      observations: Type.Array(
        strict({
          widgetId: string(),
          hash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
          issue: enumeration([
            'none',
            'label',
            'chart_type',
            'axes',
            'date_timezone',
            'units',
            'missing',
            'error',
            'clipping',
            'narrow_layout',
          ]),
          note: string(),
        }),
        { minItems: 1, maxItems: 72 },
      ),
    }),
    analyst_request_change: strict({
      ...bundle,
      boardId: uuid,
      expectedRevision: Type.Integer({ minimum: 1 }),
    }),
  });
  const descriptions = {
    analyst_discover:
      'List authorized websites, date coverage, metric capabilities, saved analyses and boards. No bulk property-value enumeration.',
    analyst_preview:
      'Validate and execute an unsaved analysis definition read-only; returns provenance and completeness. Definition is the exact nested schemaVersion 1 object (source, operation, datePolicy, semanticBinding).',
    analyst_plan_board:
      'Validate a proposed board bundle without mutation; returns the diff and whether confirmation is required.',
    analyst_commit_draft:
      "Idempotently create or revise this task's own private draft board. Widgets are {id, component:{type:'AnalysisWidget', props:{analysisRef|analysisId, visualization}}}. To revise, pass boardId + expectedRevision and keep each stable widget id; keep committed widgets by analysisId or resend them by analysisRef. Changing a committed widget requires repair.widgetId naming that widget id and may not change meaning.",
    analyst_readback:
      'Read stored board/analysis revisions and execute saved queries to compare with intent.',
    analyst_verify_render:
      'Request an isolated render of a board revision; returns a receipt and bounded screenshots when available.',
    analyst_record_inspection:
      'Record screenshot observations keyed to receipt, screenshot hash and widget ID.',
    analyst_request_change:
      'Propose an exact change to an existing board; the user must confirm before anything is applied.',
  };
  for (const name of active) {
    pi.registerTool({
      name,
      label: name,
      description:
        descriptions[name] ??
        `Umami assistant ${name}. Host validates authorization and waits for the user's confirmation of destructive operations.`,
      parameters: parameters[name],
      async execute(_id, args, signal, _update, ctx) {
        if (signal?.aborted) throw new Error('Cancelled');
        const payload = JSON.stringify({ name, args });
        if (Buffer.byteLength(payload) > 32768) throw new Error('Arguments too large');
        const value = await ctx.ui.input('umami-assistant-tool', payload);
        if (value === undefined) throw new Error('Host denied tool');
        const images = imageContent(name, value);
        if (images) return { content: images, details: {}, isError: false };
        let isError = false;
        try {
          isError = JSON.parse(value)?.ok === false;
        } catch {
          /* Text interaction replies are valid. */
        }
        return { content: [{ type: 'text', text: value }], details: {}, isError };
      },
    });
  }
  pi.on('session_start', (_event, ctx) => {
    pi.setActiveTools(active);
    if (JSON.stringify(pi.getActiveTools().sort()) !== JSON.stringify([...active].sort()))
      process.exit(1);
    let origin;
    try {
      origin = new URL(ctx.model.baseUrl).origin;
    } catch {
      process.exit(1);
    }
    if (
      ctx.model?.provider !== process.env.AI_PROVIDER ||
      ctx.model?.id !== process.env.AI_MODEL ||
      ctx.model?.baseUrl !== process.env.AI_BASE_URL ||
      !(process.env.AI_EGRESS_ORIGINS || '').split(',').includes(origin)
    )
      process.exit(1);
  });
  pi.on('tool_call', event => {
    if (!active.includes(event.toolName)) return { block: true, reason: 'Tool denied' };
  });
}
