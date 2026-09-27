/** Operator-controlled creation of the first platform administrator.
 *
 * This is the documented path for a real installation: no HTTP endpoint is required, no
 * demonstration data exists, and the command refuses to run once an operator is present.
 *
 *   SMARTGATE_OPERATOR_PASSWORD='...' npm run setup:operator -- \
 *     --email operator@example.com --name "Operations lead"
 */
import { createInterface } from "node:readline/promises";
import { Store } from "../apps/api/dist/store.js";
import { Identity } from "../apps/api/dist/identity.js";

const args = new Map();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (!token.startsWith("--")) continue;
  const [key, inline] = token.slice(2).split("=");
  args.set(key, inline ?? argv[index + 1]);
  if (inline === undefined) index += 1;
}
if (args.has("help") || !args.has("email")) {
  console.log(`Usage:
  npm run setup:operator -- --email <address> [--name "<name>"] [--password <secret>]

If --password is omitted, SMARTGATE_OPERATOR_PASSWORD is used, or you are prompted.
The account is refused if a platform administrator already exists.`);
  process.exit(args.has("help") ? 0 : 1);
}
const email = args.get("email");
const name = args.get("name") || "Platform administrator";
if (process.env.NODE_ENV === "production") {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required to bootstrap an operator in production.");
    process.exit(1);
  }
  if (process.env.SMARTGATE_DEMO !== "false") {
    console.error("Set SMARTGATE_DEMO=false before bootstrapping a production operator.");
    process.exit(1);
  }
  if (process.env.SMARTGATE_SKIP_MIGRATIONS !== "true") {
    console.error("Set SMARTGATE_SKIP_MIGRATIONS=true after applying migrations separately.");
    process.exit(1);
  }
}
let password = args.get("password") || process.env.SMARTGATE_OPERATOR_PASSWORD || "";
if (!password) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  password = await prompt.question("Operator password (minimum 12 characters): ");
  prompt.close();
}
const store = new Store();
try {
  await store.start({ demo: false });
  const identity = new Identity(store);
  if (await identity.hasOperator()) {
    console.error("A platform administrator already exists. Refusing to create another.");
    console.error("Create further accounts through an invitation instead.");
    process.exitCode = 1;
  } else {
    const created = await identity.createOperator({ email, name, password });
    console.log("Created platform administrator " + created.email + " (" + created.user_id + ")");
    console.log(
      "Sign in to the management app; production requires two-step verification setup first.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await store.close();
}
