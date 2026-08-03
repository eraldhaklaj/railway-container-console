# Container console

Spins containers up and down on Railway through the public GraphQL API. React + TypeScript front end, Node + TypeScript API, deployed on Railway as a single service.

Built for Railway's Senior Full-Stack Engineer (Product) take-home.

---

## Running it

```bash
npm install
cp .env.example .env      # fill it in, see below
npm run dev               # api on :3000, vite on :5173 proxying /api
```

Production is one process: `npm run build` compiles the front end to `web/dist` and the API to `dist`, then `npm start` serves both from the same origin.

### Environment

| Variable | What it is |
| --- | --- |
| `RAILWAY_API_TOKEN` | Account or workspace token from railway.com/account/tokens |
| `RAILWAY_PROJECT_ID` | The one project this console may touch, from the project URL |
| `RAILWAY_ENVIRONMENT_ID` | Environment within that project, usually `production` |
| `ACCESS_KEY` | Shared secret the UI presents. `openssl rand -hex 24` |
| `MAX_CONTAINERS` | Ceiling on concurrent containers, default 5 |
| `ALLOWED_IMAGES` | Comma-separated allowlist |

---

## The four decisions worth defending

**1. The token never reaches the browser.** Every Railway call goes through the Node API. The obvious reason is that a Railway account token in client-side JavaScript is an account takeover. The less obvious one is that keeping it server-side is what makes decisions 2 and 3 enforceable at all.

**2. Project and environment are server config, not request parameters.** The client can't name a project. If it could, anyone who found the URL could create services anywhere that token reaches, and the token reaches everything in the workspace. Scoping at the boundary means the worst case is bounded by config rather than by whatever the caller typed.

**3. It's gated, and the image list is an allowlist.** This app has a button that provisions real infrastructure and spends real money on a real account. Deployed on a public URL with no gate, it's a crypto miner with extra steps: free compute, someone else's card. So there's a shared secret in front of the API, an allowlist of images rather than a free-text field, and a hard ceiling on concurrent containers. None of that is sophisticated. All of it is the difference between a demo and a liability.

**4. Spin-up is idempotent.** `POST /api/containers` honours an `Idempotency-Key`, and the client sends one per attempt. Creating a service is a billable side effect, so a double click, a flaky connection, or a retry must not produce two. The store is an in-memory `Map` with a ten minute TTL, which is honest for a single instance and wrong the moment there are two. Noted below rather than papered over.

---

## How the UI handles state

Deployments move `QUEUED → BUILDING → DEPLOYING → SUCCESS`, or fall out into `FAILED` / `CRASHED`. Three things follow from that:

- **Polling stops when nothing can change.** TanStack Query's `refetchInterval` returns `false` once every row is in a terminal state, and 4s otherwise. Polling a settled list forever is the default mistake and it's free to avoid.
- **Deletion is optimistic, creation is not.** Spin-down removes the row immediately and rolls back on failure, because waiting on a round trip to see a thing disappear feels broken. Spin-up waits, because inventing a row for a service that may fail to create is a lie the UI then has to retract.
- **Railway's error message is passed through.** GraphQL reports failures in a 200 response body, so the client checks `errors` before status, and the real message reaches the user instead of "something went wrong."

## API

| | |
| --- | --- |
| `GET /healthz` | Unauthenticated, for the platform health check |
| `GET /api/meta` | Allowed images and the ceiling, so the UI can't drift from the server's rules |
| `GET /api/containers` | Services in the scoped project with their latest deployment status |
| `POST /api/containers` | Spin up. Accepts `Idempotency-Key` |
| `DELETE /api/containers/:serviceId` | Spin down, removes the service and its deployments |
| `POST /api/deployments/:id/stop` | Halt a deployment, leaving the service in place |

Both destructive paths exist on purpose. `serviceDelete` is the real spin-down. `deploymentStop` is the softer one that keeps the service so it can be redeployed, which is usually what you want when you're debugging rather than cleaning up.

---

## What I'd do next

Roughly in the order I'd actually do it.

**Move idempotency out of process.** The in-memory map is correct for one instance and silently wrong for two, because a retry can land on the replica that has never seen the key. Redis with the same TTL, or a `request_id` unique index in Postgres.

**Replace polling with the subscription.** Railway exposes `wss://backboard.railway.com/graphql/v2`. Polling every 4s is fine for five containers and obviously wrong for five hundred. The reason I didn't start there is that a subscription needs reconnect, backfill on reconnect, and a fallback when the socket won't open, and polling is the honest version of the small thing.

**Give spin-up a job, not a request.** Right now the HTTP request is the unit of work, so a request that dies mid-flight leaves a service created and nobody tracking it. Real answer is to write an intent record, return immediately, and let a worker drive it to a terminal state with retries. This is where I'd expect Temporal to come in, and it's the piece I have least direct experience with: my async backend work has been worker jobs and scheduled pipelines rather than durable workflow orchestration.

**Per-user auth and an audit trail.** A shared key tells you someone was allowed to do it, not who did it. Real accounts, and a row per action with actor, image, service id and outcome. On a tool that spends money, "who spun this up" is the first question anyone asks.

**Cost visibility.** The console shows what is running but not what it costs. Usage per service, and a projected monthly figure, would change how people use it.

**Tests worth having.** Right now there are none, which is the honest state of a take-home. The ones I'd write first are the ones covering decisions rather than syntax: that the allowlist rejects an unlisted image, that the ceiling holds, that a replayed idempotency key doesn't create twice, and that a GraphQL error body surfaces its message rather than a generic 500.

---

## Things I got wrong on the way

`vite build --root web` isn't valid, the root is positional. Ten minutes lost to a build that failed only in CI-shaped conditions and never in dev, which is a decent argument for running the production build locally before assuming it works.
