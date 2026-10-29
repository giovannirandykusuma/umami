// Disposable synthetic-only service. No public issuance/control endpoint.
import { createFixtureServer } from './fixture-server.mjs';
const fixture = createFixtureServer();
const originalExchange = fixture.capabilities.exchange;
let issued = false;
fixture.capabilities.exchange = async (value, audience) => {
  if (value === 'synthetic-container-once' && !issued) {
    issued = true;
    return originalExchange(fixture.issue(), audience);
  }
  return originalExchange(value, audience);
};
const listener = fixture.server.listeners('request')[0];
fixture.server.removeAllListeners('request');
fixture.server.on('request', (req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: 'http://1.1.1.1/' }).end();
  } else listener(req, res);
});
fixture.server.listen(4319, '0.0.0.0');
