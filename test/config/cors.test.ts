import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import cors from 'cors';
import express, { ErrorRequestHandler } from 'express';

import { isCorsOriginAllowed } from '../../src/config/cors.config';

const allowedOrigin = 'https://app.simpliweb.com.br';

for (const scenario of [
  { name: 'accepts requests without Origin', origin: undefined, status: 200 },
  { name: 'accepts the configured browser origin', origin: allowedOrigin, status: 200 },
  { name: 'rejects an unlisted browser origin', origin: 'https://untrusted.example', status: 500 },
  { name: 'rejects the literal null origin', origin: 'null', status: 500 },
]) {
  test(scenario.name, async (context) => {
    const app = express();
    app.use(
      cors({
        origin(origin, callback) {
          if (isCorsOriginAllowed(origin, [allowedOrigin])) {
            return callback(null, true);
          }
          return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
      }),
    );
    app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));
    const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
      res.status(500).json({ message: error.message });
    };
    app.use(handleError);

    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    context.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/health/live`, {
      headers: scenario.origin === undefined ? {} : { Origin: scenario.origin },
    });

    assert.equal(response.status, scenario.status);
    assert.equal(
      response.headers.get('access-control-allow-origin'),
      scenario.status === 200 && scenario.origin !== undefined ? scenario.origin : null,
    );
    assert.deepEqual(
      await response.json(),
      scenario.status === 200 ? { status: 'alive' } : { message: 'Not allowed by CORS' },
    );
  });
}

test('preserves explicitly configured wildcard behavior', () => {
  assert.equal(isCorsOriginAllowed('https://untrusted.example', ['*']), true);
});

test('requires an exact match for an Origin header', () => {
  assert.equal(isCorsOriginAllowed(`${allowedOrigin}.untrusted.example`, [allowedOrigin]), false);
  assert.equal(isCorsOriginAllowed('', [allowedOrigin]), false);
  assert.equal(isCorsOriginAllowed(undefined, []), true);
});
