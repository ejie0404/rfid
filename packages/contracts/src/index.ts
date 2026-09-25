import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import formats from "ajv-formats";
const ajv = new Ajv({ allErrors: true, strict: false });
// ajv-formats exposes a CJS default under NodeNext.
const addFormats = formats as unknown as (instance: Ajv) => void;
addFormats(ajv);
const schemas = ["configuration", "access-event", "heartbeat"] as const;
const validators = Object.fromEntries(
  schemas.map((name) => [
    name,
    ajv.compile(
      JSON.parse(
        readFileSync(
          new URL("../../../contracts/edge/v1/" + name + ".schema.json", import.meta.url),
          "utf8",
        ),
      ),
    ),
  ]),
);
export function validateProtocol(name: (typeof schemas)[number], value: unknown): boolean {
  return !!validators[name]?.(value);
}
export function protocolErrors(name: (typeof schemas)[number]) {
  return validators[name]?.errors;
}
export const IDS = {
  organization: "11111111-1111-4111-8111-111111111111",
  otherOrganization: "22222222-2222-4222-8222-222222222222",
  edge: "33333333-3333-4333-8333-333333333333",
  site: "44444444-4444-4444-8444-444444444444",
  lane: "55555555-5555-4555-8555-555555555555",
  property: "66666666-6666-4666-8666-666666666666",
} as const;
export const DEMO_EDGE_TOKEN = "smartgate-local-simulator-only";
export type CredentialFormat = "epc" | "wiegand26" | "wiegand34";
export interface Credential {
  id: string;
  format: CredentialFormat;
  value: string;
  status: "active" | "suspended" | "lost" | "revoked";
  vehicle_id: string;
  vehicle_plate: string;
  lane_ids: string[];
  valid_from: string;
  valid_until: string | null;
}
export interface Configuration {
  schema_version: 1;
  organization_id: string;
  edge_id: string;
  site_id: string;
  version: number;
  generated_at: string;
  credentials: Credential[];
}
export interface AccessEvent {
  schema_version: 1;
  event_id: string;
  organization_id: string;
  edge_id: string;
  lane_id: string;
  observed_at: string;
  edge_sequence: number;
  format: CredentialFormat;
  value: string;
  credential_id: string | null;
  vehicle_id: string | null;
  vehicle_plate: string | null;
  decision: "granted" | "denied";
  reason: string;
  barrier_outcome: "not_requested" | "simulated_open" | "cooldown" | "fault";
  passage_confirmed: false;
  config_version: number;
  offline: boolean;
}
