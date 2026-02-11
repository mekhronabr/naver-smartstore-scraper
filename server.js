import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { WorkerPool } from "./workerPool.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const jobs = new Map();

const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}, 60_000).unref();

const pool = new WorkerPool({
  size: Number(process.env.WORKERS || 1),
  headless: process.env.HEADLESS !== "false",
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/naver", async (req, res) => {
  const productUrl = String(req.query.productUrl || "").trim();

  if (!productUrl) return res.status(400).json({ error: "productUrl is required" });
  if (!/^https?:\/\/smartstore\.naver\.com\/[^/]+\/products\/\d+/i.test(productUrl)) {
    return res.status(400).json({ error: "productUrl must be a smartstore product URL" });
  }

  const jobId = crypto.randomUUID();
  const input = { productUrl };

  jobs.set(jobId, {
    status: "queued",
    message: "Queued",
    input,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  pool
    .submitJob(
      input,
      (patch) => {
        const cur = jobs.get(jobId);
        if (!cur) return;
        jobs.set(jobId, { ...cur, ...patch, updatedAt: Date.now() });
      }
    )
    .then((result) => {
      const cur = jobs.get(jobId);
      if (!cur) return;
      jobs.set(jobId, { ...cur, status: "done", message: "Done", result, updatedAt: Date.now() });
    })
    .catch((e) => {
      const cur = jobs.get(jobId);
      if (!cur) return;
      jobs.set(jobId, {
        ...cur,
        status: "error",
        message: "Error",
        error: String(e?.message ?? e),
        updatedAt: Date.now(),
      });
    });

  res.status(202).json({
    jobId
  });
});

app.get("/naver/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(job);
});

const port = process.env.PORT || 3000;

app.listen(port, async () => {
  await pool.start();
  console.log(`API listening on http://localhost:${port}`);
});