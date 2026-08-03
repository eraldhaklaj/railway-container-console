/**
 * Thin typed client over Railway's public GraphQL API.
 *
 * Everything that touches the account token lives here and only here, on the
 * server. The browser never sees it and never names a project or environment:
 * those come from config, so a caller can only ever act inside the one project
 * this deployment is scoped to.
 */

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

export type DeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CRASHED"
  | "REMOVED"
  | "SLEEPING"
  | "SKIPPED"
  | "WAITING"
  | "QUEUED";

/** Statuses that will never change again on their own, so polling can stop. */
export const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SKIPPED",
]);

export class RailwayError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "RailwayError";
  }
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (cause) {
    throw new RailwayError(`Could not reach the Railway API: ${(cause as Error).message}`, 504);
  }

  if (res.status === 401 || res.status === 403) {
    throw new RailwayError("Railway rejected the API token.", 401);
  }

  const body = (await res.json().catch(() => ({}))) as GqlResponse<T>;

  // GraphQL reports failures in the body with a 200, so check errors before status.
  if (body.errors?.length) {
    throw new RailwayError(body.errors.map((e) => e.message).join("; "));
  }
  if (!res.ok) {
    throw new RailwayError(`Railway API returned ${res.status}.`);
  }
  if (!body.data) {
    throw new RailwayError("Railway API returned no data.");
  }
  return body.data;
}

/* ------------------------------------------------------------------ */

export interface ContainerSummary {
  serviceId: string;
  name: string;
  image: string | null;
  status: DeploymentStatus | "UNKNOWN";
  deploymentId: string | null;
  url: string | null;
  createdAt: string;
}

interface ServicesQuery {
  project: {
    services: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          createdAt: string;
          serviceInstances: {
            edges: Array<{
              node: {
                environmentId: string;
                source: { image: string | null } | null;
                latestDeployment: {
                  id: string;
                  status: DeploymentStatus;
                  staticUrl: string | null;
                  url: string | null;
                } | null;
              };
            }>;
          };
        };
      }>;
    };
  };
}

const LIST = /* GraphQL */ `
  query containers($projectId: String!) {
    project(id: $projectId) {
      services {
        edges {
          node {
            id
            name
            createdAt
            serviceInstances {
              edges {
                node {
                  environmentId
                  source {
                    image
                  }
                  latestDeployment {
                    id
                    status
                    staticUrl
                    url
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export async function listContainers(
  token: string,
  projectId: string,
  environmentId: string,
): Promise<ContainerSummary[]> {
  const data = await gql<ServicesQuery>(token, LIST, { projectId });

  return data.project.services.edges.map(({ node }) => {
    // A service has one instance per environment; we only care about ours.
    const instance =
      node.serviceInstances.edges.find((e) => e.node.environmentId === environmentId)?.node ??
      node.serviceInstances.edges[0]?.node;

    const deployment = instance?.latestDeployment ?? null;
    const host = deployment?.staticUrl ?? deployment?.url ?? null;

    return {
      serviceId: node.id,
      name: node.name,
      image: instance?.source?.image ?? null,
      status: deployment?.status ?? "UNKNOWN",
      deploymentId: deployment?.id ?? null,
      url: host ? (host.startsWith("http") ? host : `https://${host}`) : null,
      createdAt: node.createdAt,
    };
  });
}

const CREATE = /* GraphQL */ `
  mutation spinUp($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
`;

export async function spinUp(
  token: string,
  projectId: string,
  name: string,
  image: string,
): Promise<{ id: string; name: string }> {
  const data = await gql<{ serviceCreate: { id: string; name: string } }>(token, CREATE, {
    input: { projectId, name, source: { image } },
  });
  return data.serviceCreate;
}

const DELETE = /* GraphQL */ `
  mutation spinDown($id: String!) {
    serviceDelete(id: $id)
  }
`;

export async function spinDown(token: string, serviceId: string): Promise<void> {
  await gql<{ serviceDelete: boolean }>(token, DELETE, { id: serviceId });
}

const STOP = /* GraphQL */ `
  mutation stop($id: String!) {
    deploymentStop(id: $id)
  }
`;

/** Halts the running deployment but leaves the service in place, so it can be redeployed. */
export async function stopDeployment(token: string, deploymentId: string): Promise<void> {
  await gql<{ deploymentStop: boolean }>(token, STOP, { id: deploymentId });
}
