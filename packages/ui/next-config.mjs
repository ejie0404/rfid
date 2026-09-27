/** Fail Vercel builds early when the statically inlined API target is missing or unsafe. */
export function validateSmartGateVercelBuild(surface) {
  if (!process.env.VERCEL) return;

  const value = process.env.NEXT_PUBLIC_SMARTGATE_API_URL?.trim();
  let url;
  try {
    if (!value) throw new Error("missing");
    url = new URL(value);
  } catch {
    throw new Error(
      `SmartGate ${surface} Vercel build requires NEXT_PUBLIC_SMARTGATE_API_URL. Set it to the HTTPS base URL of the hosted SmartGate API in this Vercel project's environment variables, then redeploy.`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  const loopback =
    hostname === "[::1]" ||
    hostname.startsWith("127.") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.";
  if (
    url.protocol !== "https:" ||
    loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `SmartGate ${surface} Vercel build requires NEXT_PUBLIC_SMARTGATE_API_URL to be a public HTTPS base URL without credentials, query, or fragment. Set it in this Vercel project's environment variables, then redeploy.`,
    );
  }
}
