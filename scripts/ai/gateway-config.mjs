// Shared synthetic gateway launcher contract. No operator file discovery or logging.
import { gatewayConfig } from '../../src/lib/ai/rpc/confinement.mjs';
export function resolveGateway(input, expectedKey) {
  const model = input.AI_MODEL ?? 'cx/gpt-6.1-sol';
  const reasoning = input.AI_REASONING_LEVEL ?? 'medium';
  if (model !== 'cx/gpt-6.1-sol' || reasoning !== 'medium')
    throw new Error('Gateway model/reasoning mismatch');
  const key = input.AI_PROVIDER_KEY ?? input.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
    throw new Error('Gateway key missing or invalid');
  if (expectedKey !== undefined && key !== expectedKey) throw new Error('Gateway key mismatch');
  let url;
  try {
    url = new URL(input.AI_BASE_URL ?? input.baseUrl);
  } catch {
    throw new Error('Gateway endpoint invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['/', '/v1', '/v1/'].includes(url.pathname)
  )
    throw new Error('Gateway endpoint invalid');
  if (input.AI_EGRESS_ORIGINS !== undefined && input.AI_EGRESS_ORIGINS !== url.origin)
    throw new Error('Gateway origin mismatch');
  const env = {
    AI_PROVIDER: input.AI_PROVIDER ?? 'nine-router',
    AI_MODEL: model,
    AI_REASONING_LEVEL: reasoning,
    AI_BASE_URL: url.origin + '/v1',
    AI_EGRESS_ORIGINS: url.origin,
    AI_PROVIDER_KEY: key,
  };
  gatewayConfig(env);
  return env;
}
