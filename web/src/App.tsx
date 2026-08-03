import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ApiError, clearKey, fetchContainers, fetchMeta, getKey, isSettled,
  setKey, spinDown, spinUp, type Container, type DeploymentStatus,
} from "./api";

/** Colour and copy for each status the API can report. */
const STATUS: Record<DeploymentStatus, { tone: string; label: string }> = {
  QUEUED:    { tone: "wait", label: "Queued" },
  WAITING:   { tone: "wait", label: "Waiting" },
  BUILDING:  { tone: "work", label: "Building" },
  DEPLOYING: { tone: "work", label: "Deploying" },
  SUCCESS:   { tone: "good", label: "Running" },
  SLEEPING:  { tone: "idle", label: "Sleeping" },
  FAILED:    { tone: "bad",  label: "Failed" },
  CRASHED:   { tone: "bad",  label: "Crashed" },
  REMOVED:   { tone: "idle", label: "Removed" },
  SKIPPED:   { tone: "idle", label: "Skipped" },
  UNKNOWN:   { tone: "idle", label: "No deployment" },
};

function Gate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="gate"
      onSubmit={(e) => {
        e.preventDefault();
        setKey(value.trim());
        onUnlock();
      }}
    >
      <h1>Container console</h1>
      <p>
        This console creates and destroys real services on a Railway account, so it is behind a
        shared key rather than open to the internet.
      </p>
      <input
        type="password"
        placeholder="Access key"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <button type="submit" disabled={!value.trim()}>Unlock</button>
    </form>
  );
}

export default function App() {
  const [unlocked, setUnlocked] = useState(() => Boolean(getKey()));
  const qc = useQueryClient();
  const [image, setImage] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const meta = useQuery({ queryKey: ["meta"], queryFn: fetchMeta, enabled: unlocked, retry: false });

  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: fetchContainers,
    enabled: unlocked,
    retry: false,
    // Poll only while a deployment can still transition. Once every row is in
    // a terminal state the interval is cleared.
    refetchInterval: (q) => {
      const rows = q.state.data;
      if (!rows || rows.length === 0) return false;
      return isSettled(rows) ? false : 4000;
    },
  });

  // A rejected key is unrecoverable in place, so clear it and return to the
  // gate rather than surfacing an unactionable error.
  useEffect(() => {
    const err = (containers.error ?? meta.error) as ApiError | null;
    if (err instanceof ApiError && err.status === 401) {
      clearKey();
      setUnlocked(false);
    }
  }, [containers.error, meta.error]);

  useEffect(() => {
    if (!image && meta.data?.allowedImages.length) setImage(meta.data.allowedImages[0]);
  }, [meta.data, image]);

  const create = useMutation({
    mutationFn: () => spinUp(image, name),
    onMutate: () => setError(null),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["containers"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const destroy = useMutation({
    mutationFn: (serviceId: string) => spinDown(serviceId),
    onMutate: async (serviceId) => {
      setError(null);
      // Remove optimistically: deletion is unambiguous and the refetch in
      // onSettled reconciles if the request fails.
      await qc.cancelQueries({ queryKey: ["containers"] });
      const previous = qc.getQueryData<Container[]>(["containers"]);
      qc.setQueryData<Container[]>(["containers"], (old) =>
        (old ?? []).filter((c) => c.serviceId !== serviceId),
      );
      return { previous };
    },
    onError: (e: Error, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["containers"], ctx.previous);
      setError(e.message);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["containers"] }),
  });

  const rows = containers.data ?? [];
  const atLimit = useMemo(
    () => Boolean(meta.data && rows.length >= meta.data.maxContainers),
    [meta.data, rows.length],
  );

  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />;

  return (
    <main>
      <header>
        <div>
          <h1>Container console</h1>
          <p className="sub">Spin containers up and down through Railway's public GraphQL API.</p>
        </div>
        <button
          className="ghost"
          onClick={() => { clearKey(); setUnlocked(false); }}
        >
          Lock
        </button>
      </header>

      <section className="panel">
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
        >
          <label>
            Image
            <select value={image} onChange={(e) => setImage(e.target.value)}>
              {meta.data?.allowedImages.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </label>
          <label>
            Name <span className="hint">optional</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto-generated"
              maxLength={31}
            />
          </label>
          <button type="submit" disabled={create.isPending || atLimit || !image}>
            {create.isPending ? "Spinning up…" : "Spin up"}
          </button>
        </form>
        {atLimit && (
          <p className="note">
            At the {meta.data?.maxContainers} container limit. Spin one down to add another.
          </p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <section>
        {containers.isLoading && <p className="note">Loading…</p>}

        {!containers.isLoading && rows.length === 0 && (
          <p className="note">Nothing running. Spin something up above.</p>
        )}

        <ul className="rows">
          {rows.map((c) => {
            const s = STATUS[c.status] ?? STATUS.UNKNOWN;
            return (
              <li key={c.serviceId}>
                <div className="meta">
                  <b>{c.name}</b>
                  <code>{c.image ?? "unknown image"}</code>
                </div>
                <span className={`pill ${s.tone}`}>{s.label}</span>
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">Open</a>
                ) : (
                  <span className="muted">no url</span>
                )}
                <button
                  className="danger"
                  onClick={() => destroy.mutate(c.serviceId)}
                  disabled={destroy.isPending}
                >
                  Spin down
                </button>
              </li>
            );
          })}
        </ul>

        {rows.length > 0 && (
          <p className="note">
            {isSettled(rows)
              ? "All settled, polling paused."
              : "Something is still deploying, refreshing every 4s."}
          </p>
        )}
      </section>
    </main>
  );
}
