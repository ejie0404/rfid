import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROBE_TIMEOUT_MS } from "../infrastructure/api-readiness-probe.mjs";

// Static guards for the container artifact. They do not replace building and running the images.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Groups Dockerfile instructions by named stage, joining backslash continuations. */
function dockerStages(source) {
  const stages = [];
  for (const instruction of source.replace(/\\\n\s*/g, " ").split("\n")) {
    const line = instruction.trim();
    if (!line || line.startsWith("#")) continue;
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(line);
    if (from) stages.push({ name: from[1], instructions: [] });
    else stages.at(-1)?.instructions.push(line);
  }
  return stages;
}

test("API and worker image targets have role-specific commands and health checks", () => {
  const stages = dockerStages(read("infrastructure/Dockerfile"));
  const stage = (name) => stages.find((candidate) => candidate.name === name)?.instructions ?? [];
  const healthchecks = (instructions) =>
    instructions.filter((line) => /^HEALTHCHECK\b/i.test(line));
  assert.equal(stages.at(-1)?.name, "api", "a build without --target produces the API image");
  assert.deepEqual(healthchecks(stage("runtime")), [], "the shared stage defines no health check");

  const worker = stage("worker");
  assert.deepEqual(healthchecks(worker), ["HEALTHCHECK NONE"]);
  assert.ok(worker.includes('CMD ["node", "apps/api/dist/move-out-worker-main.js"]'));
  assert.ok(!worker.some((line) => /^EXPOSE\b/i.test(line)), "the worker has no HTTP listener");

  const api = stage("api");
  assert.ok(api.includes('CMD ["node", "apps/api/dist/main.js"]'));
  const [healthcheck = ""] = healthchecks(api);
  assert.match(healthcheck, /CMD \["node", "infrastructure\/check-api-readiness\.mjs"\]$/);
  const timeoutSeconds = Number(/--timeout=(\d+)s/.exec(healthcheck)?.[1]);
  assert.ok(PROBE_TIMEOUT_MS < timeoutSeconds * 1000, "the probe reports its own timeout first");
});

test("the image build context excludes local data and environment files at any depth", () => {
  const patterns = read(".dockerignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const pattern of ["**/.data", "**/.env", "**/.env.*", "**/node_modules", "**/dist"])
    assert.ok(patterns.includes(pattern), `${pattern} must be excluded from the build context`);
});
