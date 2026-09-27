import { validateSmartGateVercelBuild } from "../../packages/ui/next-config.mjs";

validateSmartGateVercelBuild("control");

export default {
  output: "export",
  transpilePackages: ["@smartgate/ui"],
  images: { unoptimized: true },
  poweredByHeader: false,
};
