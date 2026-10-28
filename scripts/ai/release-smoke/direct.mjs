// Bounded synthetic gateway probe: one plain request, and only on success one tool request.
// Credentials and base URL come exclusively from the operator environment.
const base = new URL(process.env.AI_BASE_URL);
if (
  base.protocol !== 'https:' ||
  base.pathname !== '/v1' ||
  base.search ||
  base.hash ||
  base.username ||
  base.password
)
  throw new Error('invalid-provider-config');
if (
  process.env.AI_PROVIDER !== 'nine-router' ||
  process.env.AI_MODEL !== 'cx/gpt-6.1-sol' ||
  process.env.AI_EGRESS_ORIGINS !== base.origin
)
  throw new Error('invalid-provider-config');
async function probe(tool) {
  const body = {
    model: process.env.AI_MODEL,
    max_tokens: tool ? 512 : 64,
    stream: false,
    messages: [
      {
        role: 'user',
        content: tool
          ? 'Invented synthetic test. Call propose_board once with message OK and draft {"rows":[{"id":"row","columns":[{"id":"col","component":{"type":"TextBlock","props":{"text":"Invented"}}}]}]}. No analytics.'
          : 'reply OK',
      },
    ],
    ...(tool
      ? {
          tools: [
            {
              type: 'function',
              function: {
                name: 'propose_board',
                description:
                  'Return the final suggestion {message,draft?}. Does not save anything.',
                parameters: { type: 'object', additionalProperties: {} },
              },
            },
          ],
        }
      : {}),
  };
  try {
    const response = await fetch(`${base.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AI_PROVIDER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    // Do not emit any body, even on error.
    await response.arrayBuffer();
    console.log(
      JSON.stringify({
        probe: tool ? 'tool' : 'plain',
        httpStatus: response.status,
        category: response.ok
          ? 'success'
          : response.status >= 500
            ? 'gateway-server-error'
            : response.status === 429
              ? 'rate-limit'
              : [401, 403].includes(response.status)
                ? 'auth-error'
                : 'request-error',
        analyticsReads: 0,
      }),
    );
    return response.ok;
  } catch {
    console.log(
      JSON.stringify({
        probe: tool ? 'tool' : 'plain',
        httpStatus: null,
        category: 'transport-or-timeout',
        analyticsReads: 0,
      }),
    );
    return false;
  }
}
if (await probe(false)) await probe(true);
