import { validateSmartGateVercelBuild } from "../../packages/ui/next-config.mjs";

validateSmartGateVercelBuild("guard");

export default {
  output: "export",
  transpilePackages: ["@smartgate/ui"],
  images: { unoptimized: true },
  poweredByHeader: false,
};
