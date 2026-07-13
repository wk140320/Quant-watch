import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function createJobManager(options = {}) {
  const basePath = options.basePath;
  const publish = typeof options.publish === "function" ? options.publish : () => {};
  const handlers = new Map();
  const running = new Map();
  if (!basePath) throw new Error("Job manager requires a persistence directory.");

  const pathFor = (id) => join(basePath, `${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

  async function save(job) {
    await mkdir(basePath, { recursive: true });
    await writeFile(pathFor(job.id), JSON.stringify(job, null, 2), "utf8");
    return job;
  }

  async function get(id) {
    if (running.has(id)) return running.get(id);
    try {
      return JSON.parse(await readFile(pathFor(id), "utf8"));
    } catch {
      return null;
    }
  }

  function register(type, handler) {
    handlers.set(String(type), handler);
  }

  async function create(type, payload = {}) {
    const handler = handlers.get(String(type));
    if (!handler) throw Object.assign(new Error(`Unsupported background job type: ${type}`), { statusCode: 400 });
    const now = new Date().toISOString();
    const job = {
      id: `${String(type).replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      type: String(type),
      market: payload.market || null,
      status: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      payload,
      result: null,
      error: null,
    };
    running.set(job.id, job);
    await save(job);
    publish("job.queued", { id: job.id, type: job.type, market: job.market });
    setTimeout(async () => {
      try {
        job.status = "running";
        job.progress = 0.05;
        job.updatedAt = new Date().toISOString();
        await save(job);
        publish("job.running", { id: job.id, type: job.type, market: job.market });
        const update = async (progress, detail = {}) => {
          job.progress = Math.max(job.progress, Math.min(0.98, Number(progress || 0)));
          job.updatedAt = new Date().toISOString();
          job.detail = detail;
          await save(job);
          publish("job.progress", { id: job.id, type: job.type, progress: job.progress, detail });
        };
        job.result = await handler(payload, update);
        job.status = "complete";
        job.progress = 1;
        job.updatedAt = new Date().toISOString();
        await save(job);
        publish("job.complete", { id: job.id, type: job.type, market: job.market });
      } catch (error) {
        job.status = "failed";
        job.error = error.message || String(error);
        job.updatedAt = new Date().toISOString();
        await save(job);
        publish("job.failed", { id: job.id, type: job.type, market: job.market, error: job.error });
      } finally {
        running.delete(job.id);
      }
    }, 0).unref?.();
    return job;
  }

  return { create, get, register };
}

export { createJobManager };
