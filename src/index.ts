import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  listContainers,
  spinDown,
  spinUp,
  stopDeployment,
  RailwayError,
  type ContainerSummary,
} from "./railway.js";

const config = loadConfig();
const app = express();
app.use(express.json());

const dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(dirname, "..", "web", "dist");

/* -------------------------------------------------------------------------
 * Auth. The deployed URL is public and every spin-up costs real money on a
 * real account, so the API is gated behind a shared secret. Not sophisticated,
 * but the alternative is leaving a "create infrastructure" button on the open
 * internet, which is the actual mistake.
 * ---------------------------------------------------------------------- */
function requireKey(req: Request, res: Response, next: NextFunction): void {
  const presented = req.get("x-access-key");
  if (presented !== config.accessKey) {
    res.status(401).json({ error: "Invalid or missing access key." });
    return;
  }
  next();
}

/* -------------------------------------------------------------------------
 * Idempotency. Spin-up is not safe to retry: two identical POSTs create two
 * services and bill for both. Clients send an Idempotency-Key and a repeat
 * within the window returns the original result instead of acting again.
 *
 * In-memory is the honest choice for a single-instance demo. The moment this
 * runs on more than one replica it needs to move to Redis or a table, which is
 * noted in the README rather than pretended away.
 * ---------------------------------------------------------------------- */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const seen = new Map<string, { at: number; body: unknown }>();

function idempotent(req: Request, res: Response, next: NextFunction): void {
  const key = req.get("idempotency-key");
  if (!key) {
    next();
    return;
  }
  const now = Date.now();
  for (const [k, v] of seen) if (now - v.at > IDEMPOTENCY_TTL_MS) seen.delete(k);

  const hit = seen.get(key);
  if (hit) {
    res.status(200).json(hit.body);
    return;
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode < 400) seen.set(key, { at: now, body });
    return json(body);
  };
  next();
}

/* ---------------------------------- API --------------------------------- */

const api = express.Router();
api.use(requireKey);

/** What the UI is allowed to offer, so the two never drift apart. */
api.get("/meta", (_req, res) => {
  res.json({ allowedImages: config.allowedImages, maxContainers: config.maxContainers });
});

api.get(
  "/containers",
  async (_req, res: Response<ContainerSummary[] | { error: string }>, next) => {
    try {
      res.json(await listContainers(config.railwayToken, config.projectId, config.environmentId));
    } catch (err) {
      next(err);
    }
  },
);

api.post("/containers", idempotent, async (req, res, next) => {
  try {
    const image = String(req.body?.image ?? "").trim();
    const name = String(req.body?.name ?? "").trim();

    if (!image) {
      res.status(400).json({ error: "An image is required." });
      return;
    }
    // Allowlist rather than validation: this token can run anything, and an
    // open image field on a public URL is a crypto miner waiting to happen.
    if (config.allowedImages.length && !config.allowedImages.includes(image)) {
      res.status(400).json({ error: `Image "${image}" is not on the allowlist.` });
      return;
    }
    if (name && !/^[a-z0-9][a-z0-9-]{0,30}$/i.test(name)) {
      res.status(400).json({ error: "Name must be alphanumeric with hyphens, up to 31 chars." });
      return;
    }

    const running = await listContainers(
      config.railwayToken,
      config.projectId,
      config.environmentId,
    );
    if (running.length >= config.maxContainers) {
      res.status(409).json({
        error: `Limit reached: ${config.maxContainers} containers. Spin one down first.`,
      });
      return;
    }

    const created = await spinUp(
      config.railwayToken,
      config.projectId,
      name || `${image.split(":")[0].replace(/[^a-z0-9-]/gi, "-")}-${Date.now().toString(36)}`,
      image,
    );
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

api.delete("/containers/:serviceId", async (req, res, next) => {
  try {
    await spinDown(config.railwayToken, req.params.serviceId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

api.post("/deployments/:deploymentId/stop", async (req, res, next) => {
  try {
    await stopDeployment(config.railwayToken, req.params.deploymentId);
    res.status(202).json({ stopped: true });
  } catch (err) {
    next(err);
  }
});

app.use("/api", api);

/* Unauthenticated, so a platform health check does not need the secret. */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ------------------------------- static UI ------------------------------ */

app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

/* ------------------------------- errors --------------------------------- */

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // Railway's message is the useful one, so pass it through rather than
  // flattening everything into "something went wrong".
  if (err instanceof RailwayError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(config.port, () => {
  console.log(`Console listening on :${config.port}`);
  console.log(`Scoped to project ${config.projectId}, environment ${config.environmentId}`);
  console.log(`Allowing ${config.allowedImages.length} image(s), max ${config.maxContainers}`);
});
