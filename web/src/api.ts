export type DeploymentStatus =
  | "BUILDING" | "DEPLOYING" | "SUCCESS" | "FAILED" | "CRASHED"
  | "REMOVED" | "SLEEPING" | "SKIPPED" | "WAITING" | "QUEUED" | "UNKNOWN";

export interface Container {
  serviceId: string;
  name: string;
  image: string | null;
  status: DeploymentStatus;
  deploymentId: string | null;
  url: string | null;
  createdAt: string;
}

export interface Meta {
  allowedImages: string[];
  maxContainers: number;
}

/** Terminal statuses. Polling halts once every row reports one of these. */
const TERMINAL = new Set<DeploymentStatus>([
  "SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED", "UNKNOWN",
]);

export const isSettled = (rows: Container[]): boolean => rows.every((r) => TERMINAL.has(r.status));

const KEY_STORAGE = "railway-console.key";
export const getKey = (): string => localStorage.getItem(KEY_STORAGE) ?? "";
export const setKey = (k: string): void => localStorage.setItem(KEY_STORAGE, k);
export const clearKey = (): void => localStorage.removeItem(KEY_STORAGE);

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-access-key": getKey(),
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}

export const fetchMeta = () => call<Meta>("/meta");
export const fetchContainers = () => call<Container[]>("/containers");

export const spinUp = (image: string, name: string) =>
  call<{ id: string; name: string }>("/containers", {
    method: "POST",
    // Scopes the retry window so a double submit or network retry cannot
    // create a second billable service.
    headers: { "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ image, name }),
  });

export const spinDown = (serviceId: string) =>
  call<void>(`/containers/${serviceId}`, { method: "DELETE" });

export const stopDeployment = (deploymentId: string) =>
  call<{ stopped: boolean }>(`/deployments/${deploymentId}/stop`, { method: "POST" });
