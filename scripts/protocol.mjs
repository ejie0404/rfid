import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const dir = new URL("contracts/edge/v1/", root);
const files = (await readdir(dir)).filter((f) => f.endsWith(".schema.json")).sort();
const hashes = {};
for (const file of files) {
  const data = await readFile(new URL(file, dir));
  const schema = JSON.parse(data);
  if (schema.$schema !== "http://json-schema.org/draft-07/schema#" || !schema.$id)
    throw new Error("Invalid protocol schema " + file);
  hashes[file] = createHash("sha256").update(data).digest("hex");
}
if (process.argv[2] === "bundle") {
  const out = new URL("dist/protocol-v1/", root);
  await mkdir(out, { recursive: true });
  for (const file of files) await writeFile(new URL(file, out), await readFile(new URL(file, dir)));
  await writeFile(
    new URL("manifest.json", out),
    JSON.stringify({ version: "1.0.0-draft.1", files: hashes }, null, 2) + "\n",
  );
  console.log("Protocol bundle: dist/protocol-v1 (draft; pin hashes before deployment)");
} else {
  const expected = JSON.parse(
    await readFile(new URL("contracts/edge/v1/manifest.json", root), "utf8"),
  );
  if (JSON.stringify(expected.files) !== JSON.stringify(hashes))
    throw new Error(
      "Protocol content changed. Review compatibility and update the explicit manifest.",
    );
  console.log("Protocol manifest verified: " + files.length + " schemas");
}
