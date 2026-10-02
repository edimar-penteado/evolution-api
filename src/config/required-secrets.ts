const PRODUCTION_NODE_ENV = 'PROD';

export class MissingRequiredSecretsError extends Error {
  constructor(public readonly missingSecrets: string[]) {
    super(`Missing required production secrets: ${missingSecrets.join(', ')}`);
    this.name = 'MissingRequiredSecretsError';
  }
}

export function validateRequiredSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== PRODUCTION_NODE_ENV) return;

  const requiredSecrets = ['DATABASE_CONNECTION_URI', 'AUTHENTICATION_API_KEY'];
  if (environment.CACHE_REDIS_ENABLED === 'true') {
    requiredSecrets.push('CACHE_REDIS_URI');
  }

  const missingSecrets = requiredSecrets.filter((secretName) => !environment[secretName]?.trim());
  if (missingSecrets.length > 0) {
    throw new MissingRequiredSecretsError(missingSecrets);
  }
}
