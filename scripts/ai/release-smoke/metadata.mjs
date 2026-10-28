// One metadata GET; emits only selected-model numeric/boolean budget metadata.
const url = new URL(process.env.AI_BASE_URL);
if (url.protocol !== 'https:' || url.pathname !== '/v1') throw new Error('invalid-config');
try {
  const response = await fetch(`${url.origin}/v1/models`, {
    headers: { Authorization: `Bearer ${process.env.AI_PROVIDER_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  const model = Array.isArray(data.data)
    ? data.data.find(item => item.id === 'cx/gpt-6.1-sol')
    : undefined;
  const selected = {};
  for (const key of [
    'contextWindow',
    'context_length',
    'maxTokens',
    'max_tokens',
    'max_output_tokens',
    'reasoning',
  ]) {
    if (typeof model?.[key] === 'number' || typeof model?.[key] === 'boolean')
      selected[key] = model[key];
  }
  console.log(
    JSON.stringify({ httpStatus: response.status, modelFound: !!model, metadata: selected }),
  );
} catch {
  console.log(JSON.stringify({ category: 'metadata-transport-or-format' }));
}
