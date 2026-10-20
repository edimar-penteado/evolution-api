const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const runConfiguration = (t, environment = {}) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'evolution-alarms-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const callsPath = path.join(directory, 'aws-calls.jsonl');
  writeFileSync(path.join(directory, 'aws'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.AWS_CALLS_PATH, JSON.stringify(args) + '\\n');
if (args[1] === process.env.AWS_FAIL_ACTION) {
  console.error('Simulated AWS failure');
  process.exit(1);
}
`, { mode: 0o700 });
  const result = spawnSync('/bin/bash', [path.join(__dirname, 'configure-cloudwatch-alarms.sh')], {
    encoding: 'utf8',
    env: {
      PATH: directory,
      AWS_REGION: 'sa-east-1',
      SNS_TOPIC_ARN: 'arn:aws:sns:sa-east-1:123456789012:alerts',
      AWS_CALLS_PATH: callsPath,
      ...environment,
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { result, calls };
};

for (const [name, environment] of [
  ['defaults', {}],
  ['custom configuration', {
    PM2_APP_NAME: 'custom-evolution',
    CLOUDWATCH_NAMESPACE: 'Custom/Evolution',
    CLOUDWATCH_LOG_GROUP: '/custom/evolution',
    CLOUDWATCH_ALARM_PREFIX: 'custom-evolution',
    SNS_TOPIC_ARN: 'arn:aws:sns:sa-east-1:123456789012:custom-alerts',
  }],
]) {
  test(`preserves logs and only configures process alarms with ${name}`, (t) => {
    const { result, calls } = runConfiguration(t, environment);
    assert.equal(result.status, 0, result.stderr);
    const logGroup = environment.CLOUDWATCH_LOG_GROUP || '/simpliweb/production/evolution-api';
    const namespace = environment.CLOUDWATCH_NAMESPACE || 'SimpliWeb/Evolution';
    const prefix = environment.CLOUDWATCH_ALARM_PREFIX || 'simpliweb-production-evolution';
    const processName = environment.PM2_APP_NAME || 'evolution-api';
    const topic = environment.SNS_TOPIC_ARN || 'arn:aws:sns:sa-east-1:123456789012:alerts';
    assert.deepEqual(calls, [
      ['logs', 'create-log-group', '--log-group-name', logGroup],
      ['logs', 'put-retention-policy', '--log-group-name', logGroup, '--retention-in-days', '30'],
      ...[
        ['process-offline', 'Evolution API process is not online in PM2.', 'ProcessOnline',
          'Minimum', '1', 'LessThanThreshold', 'breaching'],
        ['restart', 'Evolution API restarted under PM2.', 'RestartDelta',
          'Sum', '0', 'GreaterThanThreshold', 'notBreaching'],
      ].map(([suffix, description, metric, statistic, threshold, comparison, missing]) => [
        'cloudwatch', 'put-metric-alarm',
        '--alarm-name', `${prefix}-${suffix}`,
        '--alarm-description', description,
        '--namespace', namespace,
        '--metric-name', metric,
        '--dimensions', `Name=ProcessName,Value=${processName}`,
        '--statistic', statistic,
        '--period', '300',
        '--evaluation-periods', '1',
        '--threshold', threshold,
        '--comparison-operator', comparison,
        '--treat-missing-data', missing,
        '--alarm-actions', topic,
      ]),
    ]);
  });
}

test('stops before configuring alarms when log retention fails', (t) => {
  const { result, calls } = runConfiguration(t, { AWS_FAIL_ACTION: 'put-retention-policy' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Simulated AWS failure/);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['logs', 'create-log-group'],
    ['logs', 'put-retention-policy'],
  ]);
});
