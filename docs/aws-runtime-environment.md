# AWS runtime environment - Evolution API

## Contract

Development continues to use the repository `.env`; do not create production symlinks locally.

Production uses:

- SSM path `/simpliweb/prod/evolution/config`;
- service secret `simpliweb/prod/evolution/runtime` for database and Redis URIs;
- shared secret `simpliweb/prod/shared/evolution-auth` for `AUTHENTICATION_API_KEY`;
- generated file `/run/simpliweb/evolution.env`, mode `0600`;
- symlink `/srv/evolution-api/current/.env`.

The allowlist is `deploy/aws/runtime-env.schema.cjs`. Disabled integrations are intentionally absent and must be reviewed before adding their configuration or credentials.

## AWS and IAM

Use the EC2 instance profile and no static AWS keys. Required policy resources:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:GetParametersByPath",
      "Resource": "arn:aws:ssm:sa-east-1:ACCOUNT_ID:parameter/simpliweb/prod/evolution/config/*"
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": [
        "arn:aws:secretsmanager:sa-east-1:ACCOUNT_ID:secret:simpliweb/prod/evolution/runtime-*",
        "arn:aws:secretsmanager:sa-east-1:ACCOUNT_ID:secret:simpliweb/prod/shared/evolution-auth-*"
      ]
    }
  ]
}
```

Add scoped `kms:Decrypt` only for a customer-managed KMS key. Populate every `configKeys` entry as an SSM `String`. The service secret JSON contains `DATABASE_CONNECTION_URI` and `CACHE_REDIS_URI`; the shared JSON contains `AUTHENTICATION_API_KEY`. Do not expose plaintext secrets through shell history.

## Host installation

```bash
sudo install -d -m 0755 /etc/simpliweb
sudo install -m 0644 deploy/aws/simpliweb-evolution-secrets.conf.example /etc/simpliweb/simpliweb-evolution-secrets.conf
sudo install -m 0644 deploy/systemd/simpliweb-evolution-secrets.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable simpliweb-evolution-secrets.service
sudo systemctl restart simpliweb-evolution-secrets.service
sudo systemctl restart pm2-simpliweb.service
```

Adjust `NODE_BIN`, region and paths in `/etc/simpliweb/simpliweb-evolution-secrets.conf`. AWS CLI v2 and a working instance role are prerequisites.

For a release, switch `/srv/evolution-api/current`, restart the secrets unit, run database deployment from the current release, restart PM2, and verify readiness:

```bash
sudo -u simpliweb npm run db:deploy
sudo systemctl restart pm2-simpliweb.service
curl --fail http://127.0.0.1:7480/health/ready
```

The renderer refuses unknown keys, missing values and replacement of a regular `.env`. Runtime production validation independently requires the database URI, API key, and Redis URI whenever Redis is enabled.

Rotate the shared API key in one Secrets Manager version and restart Evolution and the app in the same maintenance window. When Evolution moves to its own EC2, attach only the Evolution and shared policies; keep the same AWS paths and replace loopback URLs with private DNS values in SSM.