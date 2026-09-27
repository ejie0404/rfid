/**
 * API container readiness probe. This entrypoint always runs the check; the reusable function lives
 * in api-readiness-probe.mjs so importing it never depends on detecting how this file was started.
 * Only a short status is printed, never response bodies or connection settings.
 */
import { loadRuntimeConfig } from "../apps/api/dist/runtime-config.js";
import { checkApiReadiness } from "./api-readiness-probe.mjs";

try {
  if (!(await checkApiReadiness(loadRuntimeConfig()))) {
    console.error("SmartGate API readiness check failed.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "SmartGate API readiness check could not run.",
    error instanceof Error ? error.name : "unknown",
  );
  process.exitCode = 1;
}
