import assert from 'node:assert/strict';
import test from 'node:test';

import { MissingRequiredSecretsError, validateRequiredSecrets } from '../../src/config/required-secrets';

test('skips required secret validation outside production', () => {
  assert.doesNotThrow(() => validateRequiredSecrets({ NODE_ENV: 'development' }));
});

test('accepts a complete production environment', () => {
  assert.doesNotThrow(() =>
    validateRequiredSecrets({
      NODE_ENV: 'PROD',
      DATABASE_CONNECTION_URI: 'postgresql://configured',
      AUTHENTICATION_API_KEY: 'configured',
      CACHE_REDIS_ENABLED: 'true',
      CACHE_REDIS_URI: 'redis://configured',
    }),
  );
});

test('requires the Redis URI only when Redis is enabled', () => {
  assert.throws(
    () =>
      validateRequiredSecrets({
        NODE_ENV: 'PROD',
        DATABASE_CONNECTION_URI: 'postgresql://configured',
        AUTHENTICATION_API_KEY: 'configured',
        CACHE_REDIS_ENABLED: 'true',
      }),
    (error) => {
      assert.ok(error instanceof MissingRequiredSecretsError);
      assert.deepEqual(error.missingSecrets, ['CACHE_REDIS_URI']);
      return true;
    },
  );
});