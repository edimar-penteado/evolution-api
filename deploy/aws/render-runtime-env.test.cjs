const assert = require('node:assert/strict');
const { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const dotenv = require('dotenv');

const schema = require('./runtime-env.schema.cjs');
const { RuntimeEnvironmentError, renderRuntimeEnvironment } = require('./render-runtime-env.cjs');

const valuesFor = (keys, prefix) => Object.fromEntries(keys.map((key) => [key, `${prefix}-${key}`]));

test('renders an atomic private env file and release symlink', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'evolution-runtime-env-'));
  const outputPath = path.join(temporaryDirectory, 'run', 'evolution.env');
  const linkPath = path.join(temporaryDirectory, '.env');
  const configValues = valuesFor(schema.configKeys, 'config');
  const secretValues = valuesFor(schema.secretKeys, 'secret');
  const sharedSecretValues = { AUTHENTICATION_API_KEY: 'shared-evolution-key' };
  const runAws = (args) => {
    if (args[0] === 'ssm') {
      return { Parameters: Object.entries(configValues).map(([key, Value]) => ({ Name: `/config/${key}`, Value })) };
    }
    return {
      SecretString: JSON.stringify(
        args.includes('simpliweb/prod/shared/evolution-auth') ? sharedSecretValues : secretValues,
      ),
    };
  };

  try {
    const result = renderRuntimeEnvironment({
      environment: {
        AWS_REGION: 'sa-east-1',
        SSM_PARAMETER_PATH: '/simpliweb/prod/evolution/config',
        SECRETS_MANAGER_SECRET_ID: 'simpliweb/prod/evolution/runtime',
        SHARED_SECRETS_MANAGER_SECRET_ID: 'simpliweb/prod/shared/evolution-auth',
        RUNTIME_ENV_PATH: outputPath,
        RELEASE_ENV_LINK: linkPath,
      },
      runAws,
    });

    assert.equal(result.valueCount, schema.configKeys.length + schema.secretKeys.length + 1);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath), outputPath);
    assert.deepEqual(dotenv.parse(readFileSync(outputPath)), {
      ...configValues,
      ...secretValues,
      AUTHENTICATION_API_KEY: sharedSecretValues.AUTHENTICATION_API_KEY,
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects keys outside the service allowlist', () => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'evolution-runtime-env-'));

  try {
    assert.throws(
      () =>
        renderRuntimeEnvironment({
          environment: {
            AWS_REGION: 'sa-east-1',
            SSM_PARAMETER_PATH: '/simpliweb/prod/evolution/config',
            SECRETS_MANAGER_SECRET_ID: 'simpliweb/prod/evolution/runtime',
            RUNTIME_ENV_PATH: path.join(temporaryDirectory, 'evolution.env'),
            RELEASE_ENV_LINK: path.join(temporaryDirectory, '.env'),
          },
          runAws: (args) =>
            args[0] === 'ssm'
              ? { Parameters: [{ Name: '/config/UNEXPECTED_KEY', Value: 'value' }] }
              : { SecretString: '{}' },
        }),
      (error) => error instanceof RuntimeEnvironmentError && error.message.includes('UNEXPECTED_KEY'),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});