import { request as httpRequest } from "node:http";

/** Kept below the Dockerfile HEALTHCHECK timeout so the probe reports its own failure. */
export const PROBE_TIMEOUT_MS = 2_500;

/** Check readiness using the same exact host policy as the API. */
export function checkApiReadiness(config, requestImpl = httpRequest) {
  const publicHost = config.allowedHosts[0];
  if (!publicHost) return Promise.resolve(false);

  const probeHost = ["0.0.0.0", "::"].includes(config.host) ? "127.0.0.1" : config.host;
  return new Promise((resolveResult) => {
    let settled = false;
    let request;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(ready);
    };
    const timer = setTimeout(() => {
      request?.destroy();
      finish(false);
    }, PROBE_TIMEOUT_MS);

    try {
      request = requestImpl({
        hostname: probeHost,
        port: config.port,
        method: "GET",
        path: "/health/ready",
        headers: { host: publicHost },
      });
      request.once("response", (response) => {
        response.once("error", () => finish(false));
        response.once("end", () => finish(response.statusCode === 200));
        response.resume();
      });
      request.once("error", () => finish(false));
      request.end();
    } catch {
      finish(false);
    }
  });
}
