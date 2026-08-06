const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const appName = process.env.PM2_APP_NAME || 'evolution-api';
const namespace = process.env.CLOUDWATCH_NAMESPACE || 'SimpliWeb/Evolution';
const pm2Binary = process.env.PM2_BIN || 'pm2';
const awsBinary = process.env.AWS_BIN || 'aws';
const stateDirectory = process.env.PM2_METRICS_STATE_DIR || join(homedir(), '.local', 'state', 'simpliweb');
const statePath = join(stateDirectory, `${appName}-pm2-metrics.json`);

const readState = () => {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
};

const processes = JSON.parse(execFileSync(pm2Binary, ['jlist'], { encoding: 'utf8' }));
const processInfo = processes.find((process) => process.name === appName);
if (!processInfo) {
  throw new Error(`PM2 process "${appName}" was not found`);
}

const restartCount = Number(processInfo.pm2_env?.restart_time || 0);
const processOnline = processInfo.pm2_env?.status === 'online' ? 1 : 0;
const previousState = readState();
const previousRestartCount = Object.hasOwn(previousState, 'restartCount')
  ? Number(previousState.restartCount)
  : restartCount;
const restartDelta = Math.max(0, restartCount - previousRestartCount);
const dimensions = [{ Name: 'ProcessName', Value: appName }];
const metricData = [
  { MetricName: 'ProcessOnline', Unit: 'Count', Value: processOnline, Dimensions: dimensions },
  { MetricName: 'RestartCount', Unit: 'Count', Value: restartCount, Dimensions: dimensions },
  { MetricName: 'RestartDelta', Unit: 'Count', Value: restartDelta, Dimensions: dimensions },
];

execFileSync(awsBinary, ['cloudwatch', 'put-metric-data', '--namespace', namespace, '--metric-data', JSON.stringify(metricData)], {
  stdio: 'inherit',
});

mkdirSync(stateDirectory, { recursive: true, mode: 0o750 });
const temporaryStatePath = `${statePath}.tmp`;
writeFileSync(temporaryStatePath, `${JSON.stringify({ restartCount })}\n`, { mode: 0o640 });
renameSync(temporaryStatePath, statePath);