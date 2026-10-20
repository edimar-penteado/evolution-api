#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?Configure AWS_REGION}"
: "${SNS_TOPIC_ARN:?Configure SNS_TOPIC_ARN}"

app_name="${PM2_APP_NAME:-evolution-api}"
namespace="${CLOUDWATCH_NAMESPACE:-SimpliWeb/Evolution}"
log_group="${CLOUDWATCH_LOG_GROUP:-/simpliweb/production/evolution-api}"
alarm_prefix="${CLOUDWATCH_ALARM_PREFIX:-simpliweb-production-evolution}"
dimensions="Name=ProcessName,Value=${app_name}"

aws logs create-log-group --log-group-name "$log_group" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$log_group" --retention-in-days 30

aws cloudwatch put-metric-alarm \
  --alarm-name "${alarm_prefix}-process-offline" \
  --alarm-description 'Evolution API process is not online in PM2.' \
  --namespace "$namespace" \
  --metric-name ProcessOnline \
  --dimensions "$dimensions" \
  --statistic Minimum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --treat-missing-data breaching \
  --alarm-actions "$SNS_TOPIC_ARN"

aws cloudwatch put-metric-alarm \
  --alarm-name "${alarm_prefix}-restart" \
  --alarm-description 'Evolution API restarted under PM2.' \
  --namespace "$namespace" \
  --metric-name RestartDelta \
  --dimensions "$dimensions" \
  --statistic Sum \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$SNS_TOPIC_ARN"