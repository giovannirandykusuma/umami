export const AI_READ_TOOLS = [
  'analytics_summary',
  'analytics_breakdown',
  'analytics_timeseries',
] as const;
export type AiReadTool = (typeof AI_READ_TOOLS)[number];
export const AI_LIMITS = {
  inputBytes: 32_768,
  outputBytes: 262_144,
  toolBytes: 32_768,
  tools: 8,
  turns: 12,
  timeoutMs: 45_000,
  concurrency: 2,
} as const;
export type AiEvent = { type: 'status'; status: 'started' | 'reading' | 'completed' };
export type AiTurn = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  draft?: unknown;
  signal?: AbortSignal;
  executeTool: (name: AiReadTool, args: Record<string, unknown>) => Promise<unknown>;
  onEvent?: (event: AiEvent) => void;
};
