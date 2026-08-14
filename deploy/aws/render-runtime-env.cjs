#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');

const schema = require('./runtime-env.schema.cjs');

class RuntimeEnvironmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeEnvironmentError';
  }
}

const getRequiredBootstrapValue = (environment, name) => {
  const value = environment[name]?.trim();
  if (!value) throw new RuntimeEnvironmentError(`Missing bootstrap setting: ${name}`);
  return value;
};

const parseAwsOutput = (output, operation) => {
  try {
    return typeof output === 'string' ? JSON.parse(output) : output;
  } catch {
    throw new RuntimeEnvironmentError(`AWS CLI returned invalid JSON for ${operation}`);
  }
};

const runAwsCli = (args, environment) => {
  const command = environment.AWS_CLI_BIN?.trim() || 'aws';
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment, AWS_PAGER: '' },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    throw new RuntimeEnvironmentError(`AWS CLI request failed for ${args[0]}`);
  }

  return parseAwsOutput(result.stdout, args[0]);
};

const normalizeValue = (value, key, source) => {
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new RuntimeEnvironmentError(`${source} value must be scalar: ${key}`);
  }

  const normalizedValue = String(value);
  if (normalizedValue.includes('\0')) {
    throw new RuntimeEnvironmentError(`${source} value contains a null byte: ${key}`);
  }
  return normalizedValue;
};

const assertAllowedKeys = (values, allowedKeys, source) => {
  const allowed = new Set(allowedKeys);
  const unexpectedKeys = Object.keys(values).filter((key) => !allowed.has(key)).sort();
  if (unexpectedKeys.length > 0) {
    throw new RuntimeEnvironmentError(`Unexpected ${source} keys: ${unexpectedKeys.join(', ')}`);
  }
};

const fetchParameterStoreValues = (environment, runAws) => {
  const region = getRequiredBootstrapValue(environment, 'AWS_REGION');
  const parameterPath = getRequiredBootstrapValue(environment, 'SSM_PARAMETER_PATH');
  const response = parseAwsOutput(
    runAws(
      [
        'ssm',
        'get-parameters-by-path',
        '--path',
        parameterPath,
        '--recursive',
        '--with-decryption',
        '--region',
        region,
        '--output',
        'json',
      ],
      environment,
    ),
    'ssm',
  );

  const values = {};
  for (const parameter of response?.Parameters || []) {
    const key = path.posix.basename(parameter.Name || '');
    if (!key || Object.hasOwn(values, key)) {
      throw new RuntimeEnvironmentError('Parameter Store contains an invalid or duplicate key');
    }
    values[key] = normalizeValue(parameter.Value, key, 'Parameter Store');
  }

  assertAllowedKeys(values, schema.configKeys, 'Parameter Store');
  return values;
};

const fetchSecretsManagerValues = (environment, runAws) => {
  const region = getRequiredBootstrapValue(environment, 'AWS_REGION');
  const secretId = getRequiredBootstrapValue(environment, 'SECRETS_MANAGER_SECRET_ID');
  const response = parseAwsOutput(
    runAws(
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        secretId,
        '--version-stage',
        'AWSCURRENT',
        '--region',
        region,
        '--output',
        'json',
      ],
      environment,
    ),
    'secretsmanager',
  );

  if (!response?.SecretString) {
    throw new RuntimeEnvironmentError('Secrets Manager value must be a JSON SecretString');
  }

  const parsedSecret = parseAwsOutput(response.SecretString, 'secretsmanager SecretString');
  if (!parsedSecret || Array.isArray(parsedSecret) || typeof parsedSecret !== 'object') {
    throw new RuntimeEnvironmentError('Secrets Manager SecretString must contain a JSON object');
  }

  const values = Object.fromEntries(
    Object.entries(parsedSecret).map(([key, value]) => [key, normalizeValue(value, key, 'Secrets Manager')]),
  );
  assertAllowedKeys(values, schema.secretKeys, 'Secrets Manager');
  return values;
};

const fetchSharedSecretsManagerValues = (environment, runAws) => {
  const mappings = schema.sharedSecretMappings || {};
  const sourceKeys = Object.values(mappings);
  if (sourceKeys.length === 0) return {};

  const region = getRequiredBootstrapValue(environment, 'AWS_REGION');
  const secretId = getRequiredBootstrapValue(environment, 'SHARED_SECRETS_MANAGER_SECRET_ID');
  const response = parseAwsOutput(
    runAws(
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        secretId,
        '--version-stage',
        'AWSCURRENT',
        '--region',
        region,
        '--output',
        'json',
      ],
      environment,
    ),
    'shared secretsmanager',
  );
  const parsedSecret = parseAwsOutput(response?.SecretString, 'shared secretsmanager SecretString');

  if (!parsedSecret || Array.isArray(parsedSecret) || typeof parsedSecret !== 'object') {
    throw new RuntimeEnvironmentError('Shared Secrets Manager SecretString must contain a JSON object');
  }

  assertAllowedKeys(parsedSecret, sourceKeys, 'shared Secrets Manager');
  return Object.fromEntries(
    Object.entries(mappings).map(([targetKey, sourceKey]) => [
      targetKey,
      normalizeValue(parsedSecret[sourceKey], sourceKey, 'shared Secrets Manager'),
    ]),
  );
};

const validateRequiredValues = (values) => {
  const requiredKeys = [
    ...schema.configKeys,
    ...schema.secretKeys,
    ...Object.keys(schema.sharedSecretMappings || {}),
  ];
  const missingKeys = requiredKeys.filter((key) => !values[key]?.trim());
  if (missingKeys.length > 0) {
    throw new RuntimeEnvironmentError(`Missing runtime environment keys: ${missingKeys.join(', ')}`);
  }
};

const serializeEnvironment = (values) =>
  [...schema.configKeys, ...schema.secretKeys, ...Object.keys(schema.sharedSecretMappings || {})]
    .map((key) => `${key}=${JSON.stringify(values[key])}`)
    .join('\n') + '\n';

const writeEnvironmentAtomically = (outputPath, content) => {
  if (!path.isAbsolute(outputPath)) {
    throw new RuntimeEnvironmentError('RUNTIME_ENV_PATH must be absolute');
  }

  const outputDirectory = path.dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);

  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o600);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
};

const replaceSymlinkAtomically = (targetPath, linkPath) => {
  if (!path.isAbsolute(linkPath)) {
    throw new RuntimeEnvironmentError('RELEASE_ENV_LINK must be absolute');
  }

  try {
    const existing = lstatSync(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new RuntimeEnvironmentError(`Refusing to replace non-symlink path: ${linkPath}`);
    }
    if (readlinkSync(linkPath) === targetPath) return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryLink = `${linkPath}.${process.pid}.tmp`;
  try {
    symlinkSync(targetPath, temporaryLink);
    renameSync(temporaryLink, linkPath);
  } catch (error) {
    try {
      unlinkSync(temporaryLink);
    } catch {}
    throw error;
  }
};

const renderRuntimeEnvironment = ({ environment = process.env, runAws = runAwsCli } = {}) => {
  const outputPath = getRequiredBootstrapValue(environment, 'RUNTIME_ENV_PATH');
  const linkPath = getRequiredBootstrapValue(environment, 'RELEASE_ENV_LINK');
  const configValues = fetchParameterStoreValues(environment, runAws);
  const secretValues = fetchSecretsManagerValues(environment, runAws);
  const sharedSecretValues = fetchSharedSecretsManagerValues(environment, runAws);
  const values = { ...configValues, ...secretValues, ...sharedSecretValues };

  validateRequiredValues(values);
  writeEnvironmentAtomically(outputPath, serializeEnvironment(values));
  replaceSymlinkAtomically(outputPath, linkPath);

  return { outputPath, linkPath, valueCount: Object.keys(values).length };
};

if (require.main === module) {
  try {
    const result = renderRuntimeEnvironment();
    console.log(`[runtime-env] Rendered ${schema.serviceName} environment (${result.valueCount} keys)`);
  } catch (error) {
    console.error(`[runtime-env] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RuntimeEnvironmentError,
  renderRuntimeEnvironment,
};