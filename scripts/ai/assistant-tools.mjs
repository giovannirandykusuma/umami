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
export default function (pi) {
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
  const strict = props => Type.Object(props, { additionalProperties: false });
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
  for (const name of names) {
    pi.registerTool({
      name,
      label: name,
      description: `Umami assistant ${name}. Host validates authorization and waits for the user's confirmation of destructive operations.`,
      parameters: parameters[name],
      async execute(_id, args, signal, _update, ctx) {
        if (signal?.aborted) throw new Error('Cancelled');
        const payload = JSON.stringify({ name, args });
        if (Buffer.byteLength(payload) > 32768) throw new Error('Arguments too large');
        const value = await ctx.ui.input('umami-assistant-tool', payload);
        if (value === undefined) throw new Error('Host denied tool');
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
    pi.setActiveTools(names);
    if (JSON.stringify(pi.getActiveTools().sort()) !== JSON.stringify([...names].sort()))
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
    if (!names.includes(event.toolName)) return { block: true, reason: 'Tool denied' };
  });
}
