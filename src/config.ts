/**
 * Configuration is resolved once at startup and validated eagerly, so a
 * misconfigured deployment fails fast at boot rather than on the first request
 * that happens to depend on the missing value.
 */

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for what each one is.`,
    );
  }
  return v;
}

export interface Config {
  railwayToken: string;
  projectId: string;
  environmentId: string;
  /** Shared secret required on every API call. Not optional: the API is billable. */
  accessKey: string;
  /** Upper bound on concurrent containers. */
  maxContainers: number;
  /** Permitted images. An empty list disables the allowlist. */
  allowedImages: string[];
  port: number;
}

export function loadConfig(): Config {
  const raw = process.env.ALLOWED_IMAGES?.trim();
  return {
    railwayToken: required("RAILWAY_API_TOKEN"),
    projectId: required("RAILWAY_PROJECT_ID"),
    environmentId: required("RAILWAY_ENVIRONMENT_ID"),
    accessKey: required("ACCESS_KEY"),
    maxContainers: Number(process.env.MAX_CONTAINERS ?? 5),
    allowedImages: raw
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : ["redis:7-alpine", "nginx:alpine", "postgres:16-alpine", "memcached:alpine"],
    port: Number(process.env.PORT ?? 3000),
  };
}
