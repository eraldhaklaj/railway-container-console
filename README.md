# Container console

Creates and destroys Railway services from a browser, driving the platform's public GraphQL API. React + TypeScript client, Node + TypeScript API, deployed as a single Railway service.

---

## Running locally

```bash
npm install
cp .env.example .env
npm run dev            # API on :3000, Vite on :5173 proxying /api
```

Production runs as one process. `npm run build` compiles the client to `web/dist` and the API to `dist`; `npm start` serves both from the same origin.

## Configuration

| Variable | Purpose |
| --- | --- |
| `RAILWAY_API_TOKEN` | Account or workspace token, from railway.com/account/tokens |
| `RAILWAY_PROJECT_ID` | The only project this deployment may act on |
| `RAILWAY_ENVIRONMENT_ID` | Environment within that project |
| `ACCESS_KEY` | Shared secret required on every API call. `openssl rand -hex 24` |
| `MAX_CONTAINERS` | Concurrency ceiling, default 5 |
| `ALLOWED_IMAGES` | Comma-separated image allowlist |

The configured project must not be the project this console is deployed into. A spin-down issues `serviceDelete`, which would otherwise be able to remove the console itself.

---

## Architecture

**Client → Node API → Railway GraphQL.** The client never talks to Railway directly.

### Token isolation

The account token is confined to `src/railway.ts` and never reaches the browser. Beyond the obvious credential exposure, server-side confinement is what makes the scoping and allowlisting below enforceable rather than advisory.

### Request-independent scoping

Project and environment identifiers come from configuration, never from request input. A Railway account token authorises every project in the workspace, so accepting a project ID from the client would widen the blast radius from one project to all of them. The worst case is bounded by deployment config instead of by caller input.

### Access control and image allowlisting

Every endpoint provisions or destroys billable infrastructure on a URL reachable from the open internet. Three controls apply:

- a shared secret on all `/api` routes, checked before any handler runs
- an image allowlist rather than format validation, since the token can pull and run arbitrary public images
- a hard ceiling on concurrent services

`/healthz` is deliberately unauthenticated so platform health checks can reach it.

### Idempotent creation

`POST /api/containers` honours an `Idempotency-Key` header; the client generates one per attempt. Service creation is billable and not naturally idempotent, so a double submit or a network-level retry would otherwise produce two services.

The store is an in-process `Map` with a 10 minute TTL. This constrains the service to a single replica, because a replayed key must reach the process that recorded it. Moving to Redis or a uniquely-indexed table is the first item on the roadmap below.

### Deployment state in the client

Deployments transition `QUEUED → BUILDING → DEPLOYING → SUCCESS`, or terminate in `FAILED` / `CRASHED`. Three consequences:

- **Polling is conditional.** `refetchInterval` returns `false` once every row reports a terminal status, and 4000ms otherwise. An unconditional interval would poll a settled list indefinitely.
- **Deletion is optimistic, creation is not.** Removal is applied to the cache immediately and rolled back on failure, since the outcome is unambiguous. Creation waits for the server, because rendering a service that may fail to create would require retracting it.
- **Upstream errors propagate.** Railway returns HTTP 200 with an `errors` array on failure, so the client inspects the body before the status and surfaces the original message.

---

## API

| Route | Behaviour |
| --- | --- |
| `GET /healthz` | Unauthenticated liveness check |
| `GET /api/meta` | Allowlist and ceiling, so the client cannot drift from server constraints |
| `GET /api/containers` | Services in the scoped project with latest deployment status |
| `POST /api/containers` | Creates a service. Accepts `Idempotency-Key` |
| `DELETE /api/containers/:serviceId` | `serviceDelete`: removes the service and its deployments |
| `POST /api/deployments/:id/stop` | `deploymentStop`: halts the deployment, service remains |

Both destructive routes are exposed because they serve different cases. `serviceDelete` is a teardown. `deploymentStop` halts a running deployment while preserving the service for redeploy, which is the appropriate operation when debugging rather than cleaning up.

---

## Roadmap

**Distributed idempotency.** The in-process store is correct at one replica and silently incorrect at two, since a retry can land on an instance that has no record of the key. Redis with the same TTL, or a `request_id` unique constraint in Postgres.

**Subscriptions in place of polling.** Railway exposes `wss://backboard.railway.com/graphql/v2`. A 4 second interval is adequate at five containers and unworkable at five hundred. Deferred because a subscription requires reconnect handling, backfill on reconnect, and a polling fallback when the socket cannot open.

**Durable creation.** The HTTP request is currently the unit of work, so a request that dies mid-flight leaves a created service with nothing tracking it. The correct shape is to persist an intent record, return immediately, and drive it to a terminal state from a worker with retries and a dead-letter path.

**Per-actor authentication and audit.** A shared secret establishes that a caller was authorised, not which caller acted. Real accounts, plus an append-only record of actor, image, service ID and outcome.

**Cost surfacing.** The console reports what is running but not what it costs. Per-service usage and a projected monthly figure would change how it is used.

**Test coverage.** None currently. The first cases to cover are behavioural rather than structural: allowlist rejection of an unlisted image, ceiling enforcement at the limit, replay of an idempotency key producing one service, and propagation of a GraphQL error message rather than a generic 500.
