// Test-only preload: observes the actual native spawn without changing argv, env or permissions.
const cp = require('node:child_process');
const original = cp.spawn;
cp.spawn = function (command, args, options) {
  const child = original.apply(this, arguments);
  if (!Array.isArray(args) || !args.some(arg => String(arg).endsWith('/scripts/ai/native.mjs'))) return child;
  const result = { records: 0, invalidJson: 0, stderrBytes: 0, events: {}, categories: {}, exit: null, signal: false };
  let buffer = '';
  const count = key => { result.categories[key] = (result.categories[key] || 0) + 1; };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 2 * 1024 * 1024) { buffer = ''; count('oversize'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        result.records++;
        const allowed = ['response', 'agent_start', 'agent_end', 'message_start', 'message_update', 'message_end', 'turn_start', 'turn_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'extension_ui_request'];
        const type = allowed.includes(record.type) ? record.type : 'other';
        result.events[type] = (result.events[type] || 0) + 1;
        if (type === 'response') count(record.success === true ? (record.data?.disposition === 'started' ? 'ack-started' : 'ack-other') : 'response-error');
        if (type === 'message_end' && ['error', 'aborted'].includes(record.message?.stopReason)) {
          count('model-error');
          const error = String(record.message?.errorMessage || '');
          if (/401|unauthorized|invalid.*key/i.test(error)) count('model-auth-error');
          if (/403|forbidden/i.test(error)) count('model-forbidden');
          if (/404|not found/i.test(error)) count('model-not-found');
          if (/429|rate.?limit/i.test(error)) count('model-rate-limit');
          if (/500|502|503|504/.test(error)) count('model-server-error');
          for (const status of ['400', '401', '403', '404', '429', '500', '502', '503', '504']) {
            if (new RegExp(`\\b${status}\\b`).test(error)) count(`model-status-${status}`);
          }
          for (const [category, pattern] of Object.entries({
            'no-provider': /no (available |active |healthy )?provider/i,
            'no-credentials': /no (available |valid )?(credentials|accounts|connections)/i,
            'unsupported-model': /unsupported model|model.*not supported/i,
            'budget-error': /max.?tokens|context.?length|token.?limit|budget/i,
            'quota-error': /quota|credit|balance|capacity/i,
            'upstream-error': /upstream/i,
            'service-unavailable': /service unavailable/i,
          })) if (pattern.test(error)) count(category);
          if (/fetch failed|ECONN|ENOTFOUND|network|connect/i.test(error)) count('model-network-error');
          if (/certificate|CERT_|TLS|SSL/i.test(error)) count('model-tls-error');
          if (/permission|ERR_ACCESS_DENIED/i.test(error)) count('model-permission-error');
          if (/timeout|timed out/i.test(error)) count('model-timeout');
        }
        if (type === 'tool_execution_end' && record.isError !== false) count('tool-error');
        if (type === 'extension_ui_request') {
          if (record.method !== 'input' || record.title !== 'umami-host-tool') { count('unexpected-ui'); continue; }
          try {
            const request = JSON.parse(record.placeholder);
            if (request.name === 'propose_board') {
              count('proposal');
              count(request.args?.draft && typeof request.args.draft === 'object' ? 'draft-object' : 'draft-not-object');
            } else count('read-request');
          } catch { count('invalid-tool-json'); }
        }
      } catch { result.invalidJson++; }
    }
  });
  child.stderr.on('data', chunk => {
    result.stderrBytes += chunk.length;
    const text = chunk.toString('utf8');
    if (/ERR_ACCESS_DENIED|Access to this API has been restricted|permission denied/i.test(text)) count('permission-denied');
    if (/MODULE_NOT_FOUND|Cannot find (module|package)/.test(text)) count('module-not-found');
    if (/certificate|CERT_|TLS|SSL/.test(text)) count('tls-error');
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(text)) count('network-error');
  });
  child.once('close', (code, signal) => {
    result.exit = Number.isInteger(code) ? code : null;
    result.signal = !!signal;
    console.log('RELEASE_SMOKE_DIAGNOSTIC ' + JSON.stringify(result));
  });
  return child;
};
