/**
 * Config is read once at boot and validated loudly. A misconfigured deploy
 * should fail on startup with a readable message, not at 3am on the first
 * request that happens to need the variable.
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
  /** Shared secret the UI must present. This app can spend real money, so it is not optional. */
  accessKey: string;
  /** Hard ceiling on how many containers this console will run at once. */
  maxContainers: number;
  /** Images a caller is allowed to run. Empty means allow anything. */
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
