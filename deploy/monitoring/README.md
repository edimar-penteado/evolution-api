# Monitoramento da Evolution API

Este procedimento instala o monitoramento especifico da Evolution na EC2 de producao. Ele nao publica uma release, nao reinicia a Evolution e nao cria um canary. Usar a release ativa em `/srv/evolution-api/current`, o usuario Linux `simpliweb`, a regiao `sa-east-1` e um topico SNS com assinatura confirmada.

O CloudWatch Agent coleta os logs. Separadamente, `evolution-pm2-metrics.timer` executa um publicador Node.js por minuto, consulta o processo PM2 `evolution-api` e envia `ProcessOnline`, `RestartCount` e `RestartDelta` para `SimpliWeb/Evolution`. O filtro de logs converte `WhatsApp connection closed` em `WhatsAppDisconnect`.

O monitoramento unificado do SimpliWeb publica metricas em `SimpliWeb/Operations`. Ele nao instala automaticamente este timer. Os tres alarmes deste runbook sao adicionais e parcialmente sobrepostos aos alarmes unificados; considerar os custos, mas nao mudar namespaces ou omitir alarmes sem revisar o planejamento.

## Registro de conclusao

Em 2026-10-13, o responsavel confirmou a conclusao das etapas 1 a 10 e autorizou marcar o checklist abaixo. Este registro reflete essa confirmacao; nao representa uma nova verificacao remota da EC2 ou dos recursos AWS nesta atualizacao.

## 1. Onde executar e quais permissoes utilizar

| Acao | Ambiente / identidade |
| --- | --- |
| Conferir release, instalar arquivos, units e agente | EC2, sessao SSM, como `ssm-user`, com `sudo` |
| Consultar o PM2 e configurar sua rotacao | EC2, como `simpliweb`, sem PM2 executado como root |
| Publicar metricas e coletar logs continuamente | Perfil IAM da EC2 |
| Criar filtros/alarmes e testar notificacoes | AWS CloudShell, com identidade humana autorizada |

Os caminhos do console abaixo usam os nomes em portugues BR. As variaveis e os nomes de metricas permanecem em ingles porque sao identificadores tecnicos.

Em **EC2 > Instancias > instancia > Seguranca**, conferir o perfil IAM associado. O esperado neste ambiente e `simpliweb-prod-ec2-role`. Ele precisa de:

- `cloudwatch:PutMetricData`, permitindo o namespace `SimpliWeb/Evolution`, alem dos namespaces ja usados pela coleta unificada;
- permissoes CloudWatch Logs para criar streams, enviar eventos e definir retencao nos grupos coletados pelo agente;
- autorizacao na chave KMS dos grupos de logs, caso utilizem chave propria.

Preservar as permissoes existentes de SSM, runtime e backups. O exemplo de IAM no [runbook unificado](../../../simpliweb-server/deploy/operations/README.md) ja contempla `SimpliWeb/Evolution`. Nao conceder `PutMetricAlarm` ao perfil da EC2 apenas para facilitar o provisionamento.

A identidade humana precisa de `cloudwatch:PutMetricAlarm`, `logs:PutMetricFilter` e `logs:PutRetentionPolicy`; para consulta/testes, tambem `logs:DescribeMetricFilters`, `cloudwatch:ListMetrics`, `cloudwatch:GetMetricData`, `cloudwatch:DescribeAlarms`, `cloudwatch:DescribeAlarmHistory`, `cloudwatch:SetAlarmState` e `sns:Publish`. Se o grupo de logs ainda nao existir, cria-lo com identidade autorizada em **CloudWatch > Logs > Grupos de logs**, com nome `/simpliweb/production/evolution-api` e retencao de 30 dias. SNS/KMS podem exigir permissoes adicionais.

Nao configurar credenciais administrativas ou executar `aws login` na conta Linux da aplicacao. Nao mostrar API keys, arquivos de runtime, `pm2 env`, `printenv` ou a saida completa de `pm2 jlist`.

## 2. Conferir os pre-requisitos na EC2

Como `ssm-user`, executar:

```bash
ls -l \
  /srv/evolution-api/current/deploy/monitoring/evolution-monitoring.env.example \
  /srv/evolution-api/current/deploy/monitoring/publish-pm2-metrics.cjs \
  /srv/evolution-api/current/deploy/monitoring/configure-cloudwatch-alarms.sh \
  /srv/evolution-api/current/deploy/systemd/evolution-pm2-metrics.service \
  /srv/evolution-api/current/deploy/systemd/evolution-pm2-metrics.timer

sudo systemctl status pm2-simpliweb.service --no-pager
sudo stat /home/simpliweb/.pm2/pm2.pid

sudo -u simpliweb -H \
  /home/simpliweb/.nvm/versions/node/v24.18.0/bin/node --version

ls -l /home/simpliweb/.nvm/versions/node/v24.18.0/bin/pm2

sudo -u simpliweb -H /usr/local/bin/aws --version
sudo -u simpliweb -H /usr/local/bin/aws sts get-caller-identity \
  --region sa-east-1 --no-cli-pager
```

Esperado: artefatos presentes, daemon PM2 ativo, PID file presente, Node/PM2/AWS CLI disponiveis e identidade AWS da conta `590114615977`, com ARN de sessao do perfil da EC2.

Se o PM2 estiver inativo ou o PID file faltar, corrigir seu startup antes de continuar. O publicador chama `pm2 jlist`, que pode abrir um daemon se nao houver um existente; nao usa-lo para recuperar o PM2. Nao criar um PM2 como root ou com outro `PM2_HOME`.

Se os executaveis estiverem em outros caminhos, registrar os caminhos reais na configuracao da proxima secao. A presenca dos arquivos na release nao significa que o monitoramento ja esteja instalado.

## 3. Instalar a configuracao externa e o diretorio de estado

Como `ssm-user`:

```bash
sudo install -d -m 750 -o root -g simpliweb /etc/simpliweb
sudo install -d -m 750 -o simpliweb -g simpliweb \
  /var/lib/simpliweb/evolution-monitoring

if sudo test -e /etc/simpliweb/evolution-monitoring.env; then
  echo "Configuracao existente preservada; revisar antes de continuar."
else
  sudo install -m 640 -o root -g simpliweb \
    /srv/evolution-api/current/deploy/monitoring/evolution-monitoring.env.example \
    /etc/simpliweb/evolution-monitoring.env
fi

sudoedit /etc/simpliweb/evolution-monitoring.env
```

Preencher/revisar o arquivo com estes campos. Substituir `REPLACE_WITH_APPROVED_SNS_ARN` pelo ARN real, sem adicionar senhas:

```dotenv
AWS_REGION=sa-east-1
AWS_BIN=/usr/local/bin/aws
PM2_APP_NAME=evolution-api
PM2_HOME=/home/simpliweb/.pm2
NODE_BIN=/home/simpliweb/.nvm/versions/node/v24.18.0/bin/node
PM2_BIN=/home/simpliweb/.nvm/versions/node/v24.18.0/bin/pm2
PATH=/home/simpliweb/.nvm/versions/node/v24.18.0/bin:/usr/local/bin:/usr/bin:/bin
PM2_METRICS_STATE_DIR=/var/lib/simpliweb/evolution-monitoring
CLOUDWATCH_NAMESPACE=SimpliWeb/Evolution
CLOUDWATCH_LOG_GROUP=/simpliweb/production/evolution-api
CLOUDWATCH_ALARM_PREFIX=simpliweb-production-evolution
SNS_TOPIC_ARN=REPLACE_WITH_APPROVED_SNS_ARN
```

O template original usa um exemplo de conta SNS e um caminho PM2 que podem nao corresponder ao host. Nao deixar o ARN da conta `123456789012` nem copiar automaticamente `/home/simpliweb/.local/bin/pm2` se esse executavel nao existir. `AWS_BIN`, `PM2_HOME` e `PATH` devem ser explicitos porque systemd nao carrega o NVM do shell interativo. O `PATH` deve ser literal, sem `$PATH`.

Conferir:

```bash
sudo chown root:simpliweb /etc/simpliweb/evolution-monitoring.env
sudo chmod 640 /etc/simpliweb/evolution-monitoring.env
sudo stat -c '%a %U:%G %n' \
  /etc/simpliweb/evolution-monitoring.env \
  /var/lib/simpliweb/evolution-monitoring

sudo grep -nE 'REPLACE_|123456789012' \
  /etc/simpliweb/evolution-monitoring.env
```

Esperado: arquivo `640 root:simpliweb`, diretorio `750 simpliweb:simpliweb` e nenhum placeholder. Um erro do `grep` nao equivale a uma verificacao bem-sucedida.

Para conferir o processo com a identidade correta, entrar como usuario de aplicacao:

```bash
sudo -u simpliweb -H bash
set -a
. /etc/simpliweb/evolution-monitoring.env
set +a
systemctl is-active --quiet pm2-simpliweb.service &&
  test -s "$PM2_HOME/pm2.pid" &&
  "$PM2_BIN" list
exit
```

Executar os comandos PM2 somente depois da verificacao do daemon na secao 2. A linha `evolution-api` deve estar `online`. A lista tabular nao exibe o environment dos processos; nao substituir por um dump de `jlist`.

## 4. Conferir o CloudWatch Agent sem substituir a coleta existente

Como `ssm-user`:

```bash
sudo test -x \
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
```

Codigo de saida `0` significa que o controlador existe. Se existir, conferir:

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a status
sudo systemctl status amazon-cloudwatch-agent --no-pager
sudo ls -l /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d
sudo grep -nE 'evolution-api|/home/simpliweb/.pm2/pm2.log' \
  /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.toml
```

Ausencia do TOML ou do diretorio de configuracoes pode indicar que o agente ainda nao foi configurado. Conferir os arquivos fonte JSON usados na instalacao; nao editar o TOML gerado como configuracao permanente.

Se o agente ja estava configurado, mas esta parado, verificar primeiro o motivo no journal. Para iniciar com a configuracao existente, sem substitui-la:

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a start -m ec2
sudo systemctl enable amazon-cloudwatch-agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a status
```

Se nunca foi configurado, seguir as orientacoes de primeira configuracao da secao 4.3, pulando o download e a instalacao do pacote. Se uma configuracao anterior falhou, corrigir/reaplicar a fonte completa existente, nao troca-la pelo template exclusivo da Evolution.

### 4.1. Agente ja instalado e coleta unificada funcionando

**Nao reinstalar o agente, nao executar `fetch-config` com o template exclusivo da Evolution e nao adicionar outra coleta dos mesmos arquivos.**

A configuracao unificada de `/srv/simpliweb/current/deploy/operations/cloudwatch-agent.json` ja inclui:

- `/home/simpliweb/.pm2/logs/evolution-api-out*.log`;
- `/home/simpliweb/.pm2/logs/evolution-api-error*.log`;
- log do daemon PM2, em grupo proprio;
- metricas/logs do host, SimpliWeb e Nginx.

Em **CloudWatch > Logs > Grupos de logs > /simpliweb/production/evolution-api**, conferir streams e eventos recentes. Os nomes podem usar o ID da instancia ou hostname, conforme a configuracao aplicada.

Se os logs da Evolution estiverem sendo enviados, ir diretamente a secao 5. O timer de metricas funciona separadamente; nao depende de reinstalar ou recarregar o agente.

### 4.2. Agente ja instalado, mas faltam logs da Evolution

Preservar e revisar a configuracao ativa antes de qualquer mudanca:

```bash
sudo cp -a /opt/aws/amazon-cloudwatch-agent/etc \
  "/opt/aws/amazon-cloudwatch-agent/etc.before-evolution-$(date -u +%Y%m%dT%H%M%SZ)"
```

Se o agente usa uma configuracao personalizada com outras coletas, adicionar somente as entradas ausentes, sem substitui-la:

```bash
if sudo test -e /etc/simpliweb/evolution-cloudwatch-agent.json; then
  echo "Fonte existente preservada; revisar as entradas antes de aplicar."
else
  sudo install -m 644 \
    /srv/evolution-api/current/deploy/monitoring/cloudwatch-agent.json \
    /etc/simpliweb/evolution-cloudwatch-agent.json
fi
sudoedit /etc/simpliweb/evolution-cloudwatch-agent.json
```

Antes de aplicar, remover de `collect_list` as entradas cujos arquivos ja sao coletados, inclusive `/home/simpliweb/.pm2/pm2.log`. Remover tambem o objeto `agent` do complemento, mantendo apenas `logs`, para nao alterar o usuario/intervalo da configuracao base. Preservar JSON valido e retencao de 30 dias. Se nenhuma entrada faltar, nao aplicar o arquivo. Se o agente base nao roda como root, conferir seu acesso de leitura aos arquivos PM2.

Para adicionar esse arquivo separado:

```bash
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a append-config -m ec2 \
  -c file:/etc/simpliweb/evolution-cloudwatch-agent.json -s
sudo systemctl enable amazon-cloudwatch-agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a status
```

`append-config` preserva as outras fontes de configuracao, mas pode reiniciar o agente. Confirmar logs novos da Evolution e que metricas/logs preexistentes continuam chegando. Se a configuracao for rejeitada, verificar o log de validacao e corrigir o JSON; nao considerar sucesso apenas porque o servico estava ativo antes.

### 4.3. Agente ainda nao instalado

Somente neste caso, instalar o pacote. Os comandos abaixo sao para Ubuntu `x86_64`; conferir:

```bash
uname -m
```

Se o resultado nao for `x86_64`, usar o pacote oficial da arquitetura correta, nao o pacote abaixo.

```bash
package_dir=$(mktemp -d /tmp/evolution-cloudwatch-agent.XXXXXX)
curl --fail --show-error --location \
  https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb \
  --output "$package_dir/amazon-cloudwatch-agent.deb"
```

Conferir o sucesso do download e, conforme a politica operacional, [verificar a assinatura do pacote](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/verify-CloudWatch-Agent-Package-Signature.html). Depois:

```bash
sudo dpkg -i "$package_dir/amazon-cloudwatch-agent.deb" &&
  rm -- "$package_dir/amazon-cloudwatch-agent.deb" &&
  rmdir -- "$package_dir"
```

Nao sobrescrever configuracoes antigas apenas porque o binario faltava. Se houver fontes de configuracao de uma instalacao anterior, revisar/restaurar essa coleta antes de seguir.

Para uma primeira instalacao, neste host compartilhado usar a configuracao unificada do SimpliWeb, conforme a secao 4 do [runbook unificado](../../../simpliweb-server/deploy/operations/README.md). Ela ja coleta a Evolution. Depois seguir a secao 4.1 acima.

Somente em um host dedicado a Evolution, sem outra coleta a preservar, e apropriado instalar o template exclusivo e iniciar com:

```bash
sudo install -m 644 \
  /srv/evolution-api/current/deploy/monitoring/cloudwatch-agent.json \
  /etc/simpliweb/evolution-cloudwatch-agent.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/etc/simpliweb/evolution-cloudwatch-agent.json -s
sudo systemctl enable amazon-cloudwatch-agent
```

## 5. Instalar as units e testar o publicador antes de habilitar o timer

Se as units ja existirem com ajustes locais, conferir `sudo systemctl cat evolution-pm2-metrics.service evolution-pm2-metrics.timer` antes de substitui-las. Conservar os ajustes necessarios em drop-ins, nao dentro da release imutavel.

Como `ssm-user`:

```bash
sudo install -m 644 \
  /srv/evolution-api/current/deploy/systemd/evolution-pm2-metrics.service \
  /etc/systemd/system/evolution-pm2-metrics.service
sudo install -m 644 \
  /srv/evolution-api/current/deploy/systemd/evolution-pm2-metrics.timer \
  /etc/systemd/system/evolution-pm2-metrics.timer
```

A unit versionada nao ordena o startup depois do PM2. Para este host, criar um drop-in que tambem impede uma coleta quando o daemon esta ausente:

```bash
sudo systemctl edit evolution-pm2-metrics.service
```

Inserir no trecho editavel, preservando drop-ins existentes:

```ini
[Unit]
After=network-online.target pm2-simpliweb.service
Wants=network-online.target

[Service]
ExecStartPre=/usr/bin/systemctl is-active --quiet pm2-simpliweb.service
ExecStartPre=/usr/bin/test -s /home/simpliweb/.pm2/pm2.pid
```

Isso nao inicia nem reinicia o PM2. Se ele estiver indisponivel, a coleta falha explicitamente; o alarme de dados ausentes/offline ajuda a detectar o problema. Se o servico PM2 real tiver outro nome, adaptar o drop-in.

Depois:

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/evolution-pm2-metrics.service \
  /etc/systemd/system/evolution-pm2-metrics.timer
sudo systemctl start evolution-pm2-metrics.service
sudo systemctl show evolution-pm2-metrics.service \
  -p Result -p ExecMainStatus -p ActiveState
sudo journalctl -u evolution-pm2-metrics.service -n 30 --no-pager
sudo stat -c '%a %U:%G %n' \
  /var/lib/simpliweb/evolution-monitoring/evolution-api-pm2-metrics.json
```

Esperado: `Result=success`, `ExecMainStatus=0`, estado criado pelo usuario `simpliweb` com modo `640`. `ActiveState=inactive` e normal depois do sucesso de um servico `oneshot`; a unit nao fica rodando continuamente. Nao habilitar o timer se o teste falhar.

Habilitar o agendamento:

```bash
sudo systemctl enable --now evolution-pm2-metrics.timer
sudo systemctl is-enabled evolution-pm2-metrics.timer
sudo systemctl is-active evolution-pm2-metrics.timer
sudo systemctl list-timers --all evolution-pm2-metrics.timer --no-pager
```

Esperado: `enabled`, `active` e proxima execucao agendada. Aguardar pelo menos dois ciclos e repetir a consulta de resultado/journal. O timer usa `OnBootSec=2min` e `OnUnitActiveSec=1min`; a coleta nao depende de uma sessao SSM aberta.

O estado de reinicios fica fora das releases. Nao apaga-lo em cada publicacao: sem o historico, a primeira coleta estabelece nova baseline e pode deixar de registrar um reinicio ocorrido nesse intervalo.

## 6. Conferir metricas reais no CloudWatch

Na regiao Sao Paulo, abrir **CloudWatch > Metricas > Todas as metricas > SimpliWeb/Evolution**. Selecionar a dimensao `ProcessName=evolution-api` e confirmar pontos recentes para:

| Metrica | Valor esperado |
| --- | --- |
| `ProcessOnline` | `1` com processo online; `0` se o processo conhecido estiver parado |
| `RestartCount` | Contador PM2 acumulado |
| `RestartDelta` | Normalmente `0`; diferenca positiva quando ha novos reinicios |

Nao confundir com o namespace `SimpliWeb/Operations` nem com `CWAgent`. Verificar horarios dos pontos, nao apenas a existencia do nome da metrica. A primeira coleta pode demorar alguns minutos para aparecer no console.

Nao parar ou reiniciar a Evolution so para produzir uma metrica de teste. Processo ausente do `jlist`, falha da AWS CLI ou outras excecoes podem fazer o publicador falhar sem enviar dados; o alarme de processo offline trata ausencia como falha.

## 7. Conferir/configurar rotacao dos logs PM2

Somente com o daemon e as aplicacoes online, fora de uma pausa de backup, entrar como `simpliweb` e carregar apenas a configuracao nao secreta:

```bash
sudo -u simpliweb -H bash
set -a
. /etc/simpliweb/evolution-monitoring.env
set +a
if ! systemctl is-active --quiet pm2-simpliweb.service ||
  ! test -s "$PM2_HOME/pm2.pid"; then
  echo "PM2 indisponivel; interrompendo a configuracao de rotacao." >&2
  exit 1
fi
"$PM2_BIN" list
"$PM2_BIN" get pm2-logrotate
```

Se o modulo `pm2-logrotate` ja existir, nao reinstala-lo. Conferir e, se necessario, ajustar:

```bash
"$PM2_BIN" set pm2-logrotate:max_size 20M
"$PM2_BIN" set pm2-logrotate:retain 14
"$PM2_BIN" set pm2-logrotate:compress true
"$PM2_BIN" set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
"$PM2_BIN" set pm2-logrotate:workerInterval 30
"$PM2_BIN" set pm2-logrotate:rotateInterval '0 0 * * *'
"$PM2_BIN" get pm2-logrotate
```

Se estiver ausente, executar o helper existente, que instala e configura o modulo:

```bash
cd /srv/evolution-api/current
bash deploy/pm2/configure-logrotate.sh
"$PM2_BIN" get pm2-logrotate
```

O helper executa `pm2 save`; nao roda-lo enquanto processos estiverem intencionalmente parados, durante backup/deploy ou com credenciais administrativas exportadas no shell. Preservar a politica de bootstrap que evita secrets no dump PM2. O modulo compartilha o mesmo daemon e pode afetar os logs das duas aplicacoes.

Sair do shell de aplicacao:

```bash
exit
```

A configuracao conserva 14 arquivos compactados, roda diariamente e verifica tamanho a cada 30 segundos. `retain=14` significa quantidade de arquivos, nao garantia de 14 dias. Isso e independente da retencao de 30 dias no CloudWatch. Revisar os logs antes de centraliza-los; o agente nao remove dados pessoais ou secrets emitidos pela aplicacao.

## 8. Criar os tres alarmes com identidade humana

Nao executar o provisionador como `simpliweb` esperando permissoes administrativas do perfil da EC2. No console, abrir **CloudShell**, usando a identidade autorizada da secao 1, na regiao Sao Paulo.

Transferir somente o script publico de provisionamento. No terminal local de desenvolvimento:

```bash
tar -czf /tmp/evolution-monitoring-alarms.tar.gz \
  -C /home/edimar/evolution-api \
  deploy/monitoring/configure-cloudwatch-alarms.sh
```

No CloudShell, abrir o menu **Acoes** e usar a opcao de upload de arquivo para esse pacote. Se o pacote `simpliweb-alarmes` da instalacao unificada ja contem o script, usa-lo sem outro upload. Para o pacote acima:

```bash
mkdir -p "$HOME/evolution-monitoring-alarms"
tar -xzf "$HOME/evolution-monitoring-alarms.tar.gz" \
  -C "$HOME/evolution-monitoring-alarms"
cd "$HOME/evolution-monitoring-alarms"

aws sts get-caller-identity --no-cli-pager
export AWS_REGION=sa-east-1
export AWS_DEFAULT_REGION=sa-east-1
export SNS_TOPIC_ARN='REPLACE_WITH_APPROVED_SNS_ARN'
export PM2_APP_NAME=evolution-api
export CLOUDWATCH_NAMESPACE=SimpliWeb/Evolution
export CLOUDWATCH_LOG_GROUP=/simpliweb/production/evolution-api
export CLOUDWATCH_ALARM_PREFIX=simpliweb-production-evolution
export AWS_PAGER=''
```

Substituir o ARN antes de continuar. Conferir conta/identidade e metricas recentes da secao 6. Nao enviar o arquivo de configuracao da EC2, secrets ou o environment dos processos.

Executar:

```bash
bash deploy/monitoring/configure-cloudwatch-alarms.sh
echo "Codigo de saida: $?"
```

Se o codigo nao for `0`, interromper e corrigir a falha. Codigo `0` e necessario, mas nao suficiente: o script nao tem resumo final e sua tentativa de criar o log group ignora erros. O grupo deve ter sido confirmado anteriormente. Conferir efetivamente filtro e alarmes:

```bash
aws logs describe-metric-filters \
  --region sa-east-1 \
  --log-group-name /simpliweb/production/evolution-api \
  --filter-name-prefix simpliweb-production-evolution \
  --no-cli-pager

aws cloudwatch describe-alarms \
  --region sa-east-1 \
  --alarm-name-prefix simpliweb-production-evolution- \
  --query 'MetricAlarms[].{Nome:AlarmName,Estado:StateValue,Namespace:Namespace,AcoesAtivas:ActionsEnabled,Destinos:AlarmActions}' \
  --output table --no-cli-pager
```

Esperado: filtro `simpliweb-production-evolution-whatsapp-disconnect`, namespace `SimpliWeb/Evolution` e estes alarmes:

| Nome | Condicao |
| --- | --- |
| `simpliweb-production-evolution-process-offline` | `ProcessOnline < 1`, periodo de 5 minutos; ausencia de dados tratada como falha |
| `simpliweb-production-evolution-restart` | Soma `RestartDelta > 0` em 5 minutos |
| `simpliweb-production-evolution-whatsapp-disconnect` | Soma `WhatsAppDisconnect > 0` em 5 minutos |

Todos devem ter a acao SNS correta habilitada. No console: **CloudWatch > Alarmes > Todos os alarmes**. Para o filtro: **CloudWatch > Logs > Grupos de logs > /simpliweb/production/evolution-api > Filtros de metricas**.

O script pode ser repetido para atualizar os mesmos nomes apos corrigir uma falha. Ele nao remove o conjunto unificado nem instala o timer. Nao esperar necessariamente uma metrica `WhatsAppDisconnect` antes de haver logs correspondentes; ausencia e tratada como nao alarmante nesse alarme.

## 9. Testar notificacoes sem derrubar a Evolution

No CloudShell, avisar os destinatarios e publicar:

```bash
aws sns publish \
  --region sa-east-1 \
  --topic-arn "$SNS_TOPIC_ARN" \
  --subject 'TESTE - monitoramento Evolution' \
  --message 'Teste controlado de notificacao. Nenhuma indisponibilidade real foi provocada.' \
  --no-cli-pager
```

Confirmar recebimento. Em **Amazon SNS > Topicos > topico > Assinaturas**, as assinaturas de e-mail devem estar confirmadas.

Para testar a acao de um alarme, conferir primeiro que `simpliweb-production-evolution-process-offline` esta `OK`, com notificacoes SNS habilitadas e sem acoes de EC2/escalabilidade. Depois:

```bash
aws cloudwatch set-alarm-state \
  --region sa-east-1 \
  --alarm-name simpliweb-production-evolution-process-offline \
  --state-value ALARM \
  --state-reason 'TESTE controlado de notificacao; Evolution continua online.' \
  --no-cli-pager
```

Verificar **CloudWatch > Alarmes > alarme > Historico**, recebimento do e-mail e retorno ao estado real apos avaliacao. O estado temporario pode desaparecer rapidamente. Nao parar a Evolution, desconectar WhatsApp ou publicar logs falsos para testar.

Se o SNS direto funciona, mas o alarme nao entrega, conferir a politica de acesso do topico para CloudWatch. Em topico KMS, conferir tambem acesso dos publicadores e do servico CloudWatch a chave. Este teste valida entrega, nao todas as condicoes de deteccao. O script especifico da Evolution configura notificacao de `ALARM`, nao de retorno a `OK`.

## 10. Diagnostico e criterios de conclusao

| Sintoma | Verificar |
| --- | --- |
| Unit nao encontrada | Release contem as units? Foram copiadas para `/etc/systemd/system` e houve `daemon-reload`? |
| Falha no `ExecStartPre` | PM2 ativo, nome do servico correto e PID file no `PM2_HOME` esperado |
| Node/PM2/AWS nao encontrados | Caminhos absolutos e `PATH` literal no arquivo externo; NVM interativo nao e carregado pelo systemd |
| Processo nao encontrado | Nome `evolution-api`, usuario Linux e `PM2_HOME`; nao iniciar outro daemon como tentativa de corrigir |
| `AccessDenied` na publicacao | Perfil da EC2 permite `cloudwatch:PutMetricData` em `SimpliWeb/Evolution`? |
| Metricas antigas | Timer ativo, ultima execucao, horario UTC e journal do servico |
| Metricas existem, mas logs nao | Configuracao ativa do agente, caminhos PM2 reais, permissoes Logs/KMS e grupo/streams |
| Logs existem, mas metricas nao | Agente nao substitui o publicador; conferir unit/timer e perfil da EC2 |
| Alarme de processo offline com app online | Namespace/dimensao corretos e dados recentes; publicacao ausente tambem dispara |
| Alarme nao envia e-mail | Acao habilitada, assinatura confirmada, politica SNS e KMS |

Logs de diagnostico do agente, para inspecao local:

```bash
sudo journalctl -u amazon-cloudwatch-agent -n 30 --no-pager
sudo tail -n 30 \
  /opt/aws/amazon-cloudwatch-agent/logs/configuration-validation.log
sudo tail -n 30 \
  /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log
```

Revisar e remover informacoes sensiveis antes de compartilhar diagnosticos.

- [x] Configuracao externa preenchida, com executaveis corretos e sem secrets.
- [x] Estado persistente com owner/permissoes corretos.
- [x] Agente existente preservado; logs Evolution recentes, sem coleta duplicada.
- [x] Primeiro teste da unit com `Result=success` e `ExecMainStatus=0`.
- [x] Timer `enabled`/`active`, com pelo menos dois ciclos bem-sucedidos.
- [x] Metricas recentes `ProcessName=evolution-api` em `SimpliWeb/Evolution`.
- [x] Rotacao PM2 conferida sem reinstalar modulo existente.
- [x] Filtro e tres alarmes reais conferidos.
- [x] Teste SNS e notificacao gerada pelo alarme recebidos.
- [x] Coleta unificada do host/SimpliWeb continua funcionando.

Nao marcar concluido apenas porque o timer foi habilitado. Aguardar os dados reais e a entrega de notificacoes. Nao e necessario reiniciar a EC2 para instalar este monitoramento; validar recuperacao apos reboot na janela de ensaio operacional aprovada.