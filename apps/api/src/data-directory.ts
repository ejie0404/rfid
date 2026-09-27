import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Source and compiled API modules have the same path depth below the platform root. */
export const SMARTGATE_PLATFORM_ROOT = resolve(
  fileURLToPath(new URL("../../../", import.meta.url)),
);

/** Resolve local embedded data independently of the command's current working directory. */
export function resolveDataDirectory(value = process.env.SMARTGATE_DATA_DIR) {
  const configured = value?.trim();
  return resolve(SMARTGATE_PLATFORM_ROOT, configured || ".data/postgres");
}
