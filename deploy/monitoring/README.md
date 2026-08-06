# Monitoramento da Evolution API

Use o usuario de aplicacao `simpliweb`, o checkout ativo em `/srv/evolution-api/current` e um topico SNS para os alertas. Ajuste esses caminhos nos templates se o host usar nomes diferentes.

1. Instale o CloudWatch Agent e copie `cloudwatch-agent.json` para a configuracao ativa do agente. A role da EC2 precisa permitir gravacao em CloudWatch Logs e `cloudwatch:PutMetricData` no namespace `SimpliWeb/Evolution`.
2. Copie `evolution-monitoring.env.example` para `/etc/simpliweb/evolution-monitoring.env`, preencha o ARN real do SNS e defina os caminhos absolutos de `node` e `pm2` para o usuario de aplicacao. O arquivo nao contem API keys da Evolution.
3. Instale as units de `deploy/systemd/`, crie `/var/lib/simpliweb/evolution-monitoring` com owner `simpliweb:simpliweb`, execute `systemctl daemon-reload` e habilite `evolution-pm2-metrics.timer`.
4. Como `simpliweb`, execute `bash deploy/pm2/configure-logrotate.sh` depois de iniciar a Evolution por PM2. A configuracao conserva 14 arquivos compactados, roda diariamente e tambem quando cada log atingir 20 MiB.
5. Carregue o environment de monitoramento e execute `bash deploy/monitoring/configure-cloudwatch-alarms.sh`. O script cria alarmes para processo offline, reinicio PM2 e desconexao WhatsApp.

O CloudWatch Agent coleta os logs do PM2. A desconexao gera uma linha `WhatsApp connection closed`, convertida em metrica pelo filtro do log group. O publicador consulta `pm2 jlist` a cada minuto e publica `ProcessOnline`, `RestartCount` e `RestartDelta`.