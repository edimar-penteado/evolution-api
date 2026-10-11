export function isCorsOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  return origin === undefined || allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}
