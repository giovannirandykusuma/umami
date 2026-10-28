import { Type } from '@sinclair/typebox';

export const names = ['umami_api', 'ask_user', 'show_chart', 'open_link'];
export default function (pi) {
  const string = () => Type.String({ maxLength: 4000 });
  const optional = schema => Type.Optional(schema);
  const parameters = {
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
    show_chart: Type.Object({
      title: optional(string()),
      component: Type.Object(
        {
          type: Type.Union(
            [
              'WebsiteCompareChart',
              'WebsiteChart',
              'WebsiteMetricsBar',
              'MetricsTable',
              'WorldMap',
            ].map(Type.Literal),
          ),
        },
        { additionalProperties: true },
      ),
    }),
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
        return { content: [{ type: 'text', text: value }], details: {} };
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
