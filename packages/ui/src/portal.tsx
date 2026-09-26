"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Activity,
  Building2,
  CarFront,
  Check,
  ChevronRight,
  CircleHelp,
  DoorOpen,
  Home,
  LayoutDashboard,
  LogOut,
  Plus,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  LoginScreen,
  OrganizationChooser,
  PendingInvitationScreen,
  useSession,
  type Mode,
} from "./auth";

type Vehicle = {
  id: string;
  property_id?: string;
  plate: string;
  make: string;
  color: string;
  // Household and credential detail is only sent to those who administer the village. A guard
  // receives the station lookup fields alone, so these are optional rather than assumed.
  property_label?: string;
  resident_name?: string;
  credential_id?: string;
  credential_value?: string;
  format?: string;
  credential_status?: string;
  active?: boolean;
};
type Event = {
  event_id: string;
  observed_at: string;
  vehicle_plate: string | null;
  value: string;
  decision: string;
  reason: string;
  barrier_outcome: string;
  offline: boolean;
  passage_confirmed: boolean;
};
type CredentialRequest = {
  id: string;
  property_id: string;
  vehicle_id: string;
  credential_id: string;
  status: "pending" | "issued" | "rejected";
  created_at: string;
  resolved_at: string | null;
  required_config_version: number;
  decision_note: string;
  plate: string;
  make: string;
  property_label: string;
  resident_name: string;
  expected_controllers: number;
  acknowledged_controllers: number;
};
type VehicleChangeRequest = {
  id: string;
  property_id: string;
  occupancy_id: string;
  vehicle_id: string;
  prior_plate: string;
  prior_make: string;
  prior_color: string;
  proposed_plate: string;
  proposed_make: string;
  proposed_color: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decision_note: string;
  required_config_version: number | null;
  created_at: string;
  resolved_at: string | null;
  property_label: string;
  expected_controllers: number;
  acknowledged_controllers: number;
};
type VehicleRetirementRequest = {
  id: string;
  property_id: string;
  occupancy_id: string;
  vehicle_id: string;
  source: "resident" | "hoa";
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decision_note: string;
  required_config_version: number | null;
  created_at: string;
  resolved_at: string | null;
  plate: string;
  make: string;
  property_label: string;
  expected_controllers: number;
  acknowledged_controllers: number;
};
type ScheduledMoveOut = {
  id: string;
  property_id: string;
  occupancy_id: string;
  effective_at: string;
  revision: number;
  status: "scheduled" | "completed" | "cancelled";
  property_label: string;
  resident_name: string;
  expected_controllers: number;
  acknowledged_controllers: number;
  retry_count?: number;
  last_attempt_at?: string | null;
  next_attempt_at?: string | null;
  last_processing_error?: string | null;
};
type HouseholdMember = {
  id: string;
  property_id: string;
  occupancy_id: string;
  relationship: string;
  is_primary_contact: boolean;
  started_at: string;
  ended_at: string | null;
  name: string;
  email: string;
  membership_status: string;
};
type Property = {
  id: string;
  label: string;
  resident_name: string;
  occupancy_id: string | null;
  occupancy_started_at: string | null;
  scheduled_move_out_id: string | null;
  scheduled_move_out_at: string | null;
  scheduled_expected_controllers: number | null;
  scheduled_acknowledged_controllers: number | null;
};
type Occupancy = {
  id: string;
  property_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string;
  required_config_version: number | null;
  property_label: string;
  resident_name: string;
  occupant_names: string[];
  expected_controllers: number;
  acknowledged_controllers: number;
};
type Snapshot = {
  organization: { name: string; config_version: number };
  principal: { name: string };
  vehicles: Vehicle[];
  credential_requests: CredentialRequest[];
  vehicle_change_requests: VehicleChangeRequest[];
  vehicle_retirement_requests: VehicleRetirementRequest[];
  scheduled_move_outs: ScheduledMoveOut[];
  property_members: HouseholdMember[];
  events: Event[];
  heartbeats: {
    payload: { config_version: number; pending_events: number };
    received_at: string;
  }[];
  properties: Property[];
  occupancies: Occupancy[];
  sites: { id: string; name: string; code: string }[];
  lanes: { id: string; name: string; site_id: string; direction: string }[];
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  site_id: string | null;
  property_id: string | null;
  resident_relationship: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
type Membership = {
  id: string;
  role: string;
  status: string;
  name: string;
  email: string;
};
type Controller = {
  id: string;
  site_id: string;
  name: string;
  status: string;
  protocol_version: number;
  software_version: string | null;
  hardware_mode: string;
  config_version: number;
  pending_events: number;
  last_seen_at: string | null;
  last_reported_at: string | null;
  lane_ids: string[];
};
type ControllerGrant = {
  id: string;
  site_id: string;
  name: string;
  lane_ids: string[];
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
};
type Local = {
  config_version: number;
  cloud_connected: boolean;
  pending_events: number;
  hardware: string;
  controller_id?: string;
  site_id?: string;
  lane_ids?: string[];
  configuration_age_seconds?: number | null;
  max_config_age_seconds?: number;
  authorization_available?: boolean;
  events: Event[];
};
const API = "http://127.0.0.1:4100";
const EDGE = "http://127.0.0.1:4200";
const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
const formatWhen = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString("en-PH", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Manila",
      })
    : "No contact yet";
const manilaDateTimeInput = (value: string | null | undefined) =>
  value ? new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16) : "";
const deliveryLabel = (request: CredentialRequest) => {
  const expected = Number(request.expected_controllers);
  const acknowledged = Number(request.acknowledged_controllers);
  if (!expected) return "No active controller is assigned to this credential's lanes.";
  if (acknowledged >= expected)
    return `${expected} assigned ${expected === 1 ? "controller has" : "controllers have"} acknowledged configuration v${request.required_config_version}.`;
  return `Waiting for ${expected - acknowledged} of ${expected} assigned controllers to acknowledge configuration v${request.required_config_version}.`;
};
const occupancyDeliveryLabel = (occupancy: Occupancy) => {
  const expected = Number(occupancy.expected_controllers);
  const acknowledged = Number(occupancy.acknowledged_controllers);
  if (!expected) return "No active controller was assigned to these tags at move-out.";
  if (acknowledged >= expected)
    return `${expected} assigned ${expected === 1 ? "controller has" : "controllers have"} acknowledged configuration v${occupancy.required_config_version}.`;
  return `Waiting for ${expected - acknowledged} of ${expected} assigned controllers to acknowledge configuration v${occupancy.required_config_version}.`;
};
const vehicleChangeDeliveryLabel = (request: VehicleChangeRequest) => {
  if (request.status === "pending") return "Waiting for village review.";
  if (request.status === "rejected") return "Request declined.";
  if (request.status === "cancelled") return "Cancelled when household access ended.";
  if (!request.required_config_version) return "Approved. No gate update was needed.";
  const expected = Number(request.expected_controllers);
  const acknowledged = Number(request.acknowledged_controllers);
  if (!expected) return "Approved. No active gate was assigned to this vehicle.";
  if (acknowledged >= expected)
    return `Approved. All ${expected} assigned gates received configuration v${request.required_config_version}.`;
  return `Approved. Waiting for ${expected - acknowledged} of ${expected} assigned gates to receive configuration v${request.required_config_version}.`;
};
const retirementDeliveryLabel = (request: VehicleRetirementRequest) => {
  if (request.status === "pending") return "Waiting for village review.";
  if (request.status !== "approved")
    return request.decision_note || "Request declined or cancelled.";
  if (request.required_config_version == null) return "Retired. No controller update was needed.";
  const expected = Number(request.expected_controllers);
  const acknowledged = Number(request.acknowledged_controllers);
  if (!expected) return "Retired. No active gate was assigned to this vehicle.";
  return acknowledged >= expected
    ? `All ${expected} assigned gate${expected === 1 ? " has" : "s have"} received the removal.`
    : `Waiting for ${expected - acknowledged} of ${expected} assigned gates to receive the removal.`;
};
const labels: Record<string, string> = {
  VALID_CREDENTIAL: "Registered credential",
  UNKNOWN_CREDENTIAL: "Unrecognized credential",
  CREDENTIAL_INACTIVE: "Credential is inactive",
  GATE_NOT_ALLOWED: "Lane access unavailable",
  OUTSIDE_VALIDITY: "Outside validity period",
  NO_CONFIGURATION: "Awaiting configuration",
  CLOCK_UNTRUSTED: "Controller clock needs attention",
  STALE_CONFIGURATION: "Offline policy expired",
  OFFLINE_POLICY_UNCONFIGURED: "Offline policy not configured",
  LANE_NOT_ENROLLED: "Lane is not enrolled",
};
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={"badge " + tone}>{children}</span>;
}
function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <DoorOpen size={22} />
      </span>
      <span>
        smartgate<span className="brand-dot">.</span>
      </span>
    </div>
  );
}

function mergeRowsById<T extends { id: string }>(preferred: T[], fallback: T[]) {
  const rows = new Map<string, T>();
  for (const row of [...preferred, ...fallback]) if (!rows.has(row.id)) rows.set(row.id, row);
  return [...rows.values()];
}

export function Portal({ mode }: { mode: Mode }) {
  const auth = useSession(API);
  const principal = auth.session?.principal;
  const sessionScope = principal
    ? [
        principal.sessionId,
        principal.id,
        principal.organizationId ?? "",
        principal.role,
        principal.membershipId ?? "",
        principal.supportGrantId ?? "",
      ].join(":")
    : "anonymous";
  return <PortalWorkspace key={`${mode}:${sessionScope}`} mode={mode} auth={auth} />;
}

function PortalWorkspace({ mode, auth }: { mode: Mode; auth: ReturnType<typeof useSession> }) {
  const isGuard = mode === "guard",
    isResident = mode === "resident";
  const { session, token, onUnauthorized, logout, demoEnabled } = auth;
  const canManageDevices =
    session?.principal.role === "hoa_admin" || session?.principal.role === "platform_admin";
  const canManageCredentials = session?.principal.role === "hoa_admin";
  const nav = isGuard
    ? ["Gate station", "Access activity", "Help"]
    : isResident
      ? ["My home", "My vehicles", "My activity", "Help"]
      : [
          "Overview",
          "Residents",
          "Vehicles & RFID",
          "Staff & access",
          "Access activity",
          "Gates & devices",
        ];
  const [tab, setTab] = useState(nav[0]!);
  const [data, setData] = useState<Snapshot | null>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollmentPropertyId, setEnrollmentPropertyId] = useState("new");
  const [statusChange, setStatusChange] = useState<{ vehicle: Vehicle; status: string } | null>(
    null,
  );
  const [moveOutProperty, setMoveOutProperty] = useState<Property | null>(null);
  const [moveOutEffectiveAt, setMoveOutEffectiveAt] = useState("");
  const [retirementVehicle, setRetirementVehicle] = useState<Vehicle | null>(null);
  const [retirementReason, setRetirementReason] = useState("");
  const [correctionVehicle, setCorrectionVehicle] = useState<Vehicle | null>(null);
  const [vehicleDecision, setVehicleDecision] = useState<{
    request: VehicleChangeRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [moveOutReason, setMoveOutReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanValue, setScanValue] = useState("E2000017221101441890ABCD");
  const [scanFormat, setScanFormat] = useState("epc");
  const [result, setResult] = useState<Event | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [controllers, setControllers] = useState<Controller[]>([]);
  const [controllerGrants, setControllerGrants] = useState<ControllerGrant[]>([]);
  const [controllerSiteId, setControllerSiteId] = useState("");
  const [issuedControllerGrant, setIssuedControllerGrant] = useState<{
    name: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [rotatedControllerCredential, setRotatedControllerCredential] = useState<{
    controllerId: string;
    credential: string;
  } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteRole, setInviteRole] = useState("guard");
  const [invitePropertyId, setInvitePropertyId] = useState("");
  const [issuedInvite, setIssuedInvite] = useState<{
    email: string;
    role: string;
    token: string;
  } | null>(null);
  const [memberPages, setMemberPages] = useState<
    Record<
      string,
      { items: HouseholdMember[]; cursor: string | null; loaded: boolean; busy: boolean }
    >
  >({});
  const [householdPage, setHouseholdPage] = useState<{
    search: string;
    items: Property[];
    cursor: string | null;
  } | null>(null);
  const [householdLoading, setHouseholdLoading] = useState(false);
  const [householdRefresh, setHouseholdRefresh] = useState(0);
  const householdSequence = useRef(0);
  const [pagingMessage, setPagingMessage] = useState("");
  const [lifecycleCursors, setLifecycleCursors] = useState<
    Record<string, string | null | undefined>
  >({});
  const [lifecycleBusy, setLifecycleBusy] = useState<Record<string, boolean>>({});
  const [lifecycleFilters, setLifecycleFilters] = useState<
    Record<string, "all" | "pending" | "resolved">
  >({});
  const organizationKey = session?.principal.organizationId ?? "";
  const priorOrganizationKey = useRef(organizationKey);
  const active = useRef(true);
  const loading = useRef(false);
  const request = useCallback(
    async (path: string, body?: unknown) => {
      const requestToken = session?.token ?? "";
      if (!active.current || token.current !== requestToken)
        throw new Error("Your session changed. Try again.");
      const response = await fetch(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + requestToken },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        if (active.current && token.current === requestToken) onUnauthorized();
        throw new Error("Your session has ended. Sign in again.");
      }
      if (!response.ok)
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : "The request could not be completed.",
        );
      if (body !== undefined && payload.request_id && payload.status && active.current) {
        const field = path.startsWith("/vehicle-change-requests/")
          ? "vehicle_change_requests"
          : path.startsWith("/vehicle-retirement-requests/")
            ? "vehicle_retirement_requests"
            : path.startsWith("/credential-requests/")
              ? "credential_requests"
              : null;
        if (field)
          setData((current) =>
            current
              ? {
                  ...current,
                  [field]: current[field].map((row) =>
                    row.id === payload.request_id
                      ? {
                          ...row,
                          status: payload.status,
                          required_config_version:
                            payload.required_config_version !== undefined
                              ? payload.required_config_version
                              : (payload.configuration_version ?? row.required_config_version),
                          ...(payload.expected_controllers !== undefined
                            ? { expected_controllers: payload.expected_controllers }
                            : {}),
                          ...(payload.acknowledged_controllers !== undefined
                            ? { acknowledged_controllers: payload.acknowledged_controllers }
                            : {}),
                          ...(field === "credential_requests" && payload.credential_id
                            ? { replacement_credential_id: payload.credential_id }
                            : {}),
                        }
                      : row,
                  ),
                }
              : current,
          );
      }
      return payload;
    },
    [onUnauthorized, session?.token, token],
  );
  useEffect(() => {
    if (priorOrganizationKey.current === organizationKey) return;
    priorOrganizationKey.current = organizationKey;
    setMemberPages({});
    setHouseholdPage(null);
    setLifecycleCursors({});
    setLifecycleFilters({});
    setPagingMessage("");
  }, [organizationKey]);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const work: Promise<any>[] = [request("/snapshot")];
      if (isGuard)
        work.push(
          fetch(EDGE + "/local/status", { signal: AbortSignal.timeout(2500) }).then((r) => {
            if (!r.ok) throw new Error("Station unavailable");
            return r.json();
          }),
        );
      const responses = await Promise.allSettled(work);
      if (!active.current) return;
      const cloud = responses[0]!;
      if (cloud.status === "fulfilled") {
        setData((current) => {
          if (!current) return cloud.value;
          return {
            ...cloud.value,
            vehicle_change_requests: mergeRowsById(
              cloud.value.vehicle_change_requests ?? [],
              current.vehicle_change_requests ?? [],
            ),
            credential_requests: mergeRowsById(
              cloud.value.credential_requests ?? [],
              current.credential_requests ?? [],
            ),
            vehicle_retirement_requests: mergeRowsById(
              cloud.value.vehicle_retirement_requests ?? [],
              current.vehicle_retirement_requests ?? [],
            ),
            scheduled_move_outs: mergeRowsById(
              cloud.value.scheduled_move_outs ?? [],
              current.scheduled_move_outs ?? [],
            ),
            occupancies: mergeRowsById(cloud.value.occupancies ?? [], current.occupancies ?? []),
          };
        });
        setError("");
      } else
        setError(
          isGuard
            ? "Cloud connection unavailable. Local station status is shown below."
            : "The management service is unavailable. Your gate controller operates independently.",
        );
      if (isGuard) {
        const edge = responses[1]!;
        setLocal(edge.status === "fulfilled" ? edge.value : null);
      }
    } finally {
      loading.current = false;
    }
  }, [isGuard, request]);
  useEffect(() => {
    if (tab !== "Residents" || !canManageCredentials) return;
    const sequence = ++householdSequence.current;
    const currentOrganization = organizationKey;
    const timer = setTimeout(() => {
      setHouseholdLoading(true);
      const query = new URLSearchParams({ search, limit: "50" });
      void request(`/households?${query}`)
        .then((page) => {
          if (
            sequence !== householdSequence.current ||
            currentOrganization !== priorOrganizationKey.current
          )
            return;
          setHouseholdPage({ search, items: page.items, cursor: page.next_cursor });
        })
        .catch((issue) => {
          if (sequence === householdSequence.current) setPagingMessage((issue as Error).message);
        })
        .finally(() => {
          if (sequence === householdSequence.current) setHouseholdLoading(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      householdSequence.current++;
    };
  }, [canManageCredentials, householdRefresh, organizationKey, request, search, tab]);
  const loadStaff = useCallback(async () => {
    try {
      const [pending, people] = await Promise.all([
        request("/invitations"),
        request("/memberships"),
      ]);
      setInvitations(pending);
      setMemberships(people);
    } catch (issue) {
      setNotice((issue as Error).message);
    }
  }, [request]);
  const loadControllerManagement = useCallback(async () => {
    try {
      const rows = await request("/controllers");
      setControllers(rows);
      if (canManageDevices) setControllerGrants(await request("/controllers/enrollment-grants"));
      else setControllerGrants([]);
    } catch (issue) {
      setNotice((issue as Error).message);
    }
  }, [canManageDevices, request]);
  useEffect(() => {
    if (!session) return;
    active.current = true;
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => {
      active.current = false;
      clearInterval(id);
    };
  }, [load, session]);
  useEffect(() => {
    if (session && tab === "Staff & access") void loadStaff();
  }, [loadStaff, session, tab]);
  useEffect(() => {
    if (session && tab === "Gates & devices") {
      void loadControllerManagement();
      const id = setInterval(() => void loadControllerManagement(), 15000);
      return () => clearInterval(id);
    }
  }, [loadControllerManagement, session, tab]);
  useEffect(() => {
    if (!controllerSiteId && data?.sites[0]) setControllerSiteId(data.sites[0].id);
  }, [controllerSiteId, data?.sites]);
  const vehicles = (data?.vehicles ?? []).filter((v) =>
    [v.plate, v.make, v.resident_name, v.property_label]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const residentProperties =
    householdPage?.search === search
      ? householdPage.items
      : (data?.properties ?? []).filter((property) =>
          [property.label, property.resident_name]
            .join(" ")
            .toLowerCase()
            .includes(search.toLowerCase()),
        );
  const selectedLifecycleFilter = (kind: string) => lifecycleFilters[kind] ?? "all";
  const filterLifecycleItems = <T extends { status: string }>(kind: string, items: T[]) => {
    const filter = selectedLifecycleFilter(kind);
    if (filter === "all") return items;
    const isPending = (status: string) =>
      kind === "move_outs" ? status === "scheduled" : status === "pending";
    return items.filter((item) =>
      filter === "pending" ? isPending(item.status) : !isPending(item.status),
    );
  };
  function chooseLifecycleFilter(kind: string, filter: "all" | "pending" | "resolved") {
    setLifecycleFilters((current) => ({ ...current, [kind]: filter }));
    setLifecycleCursors((current) => ({ ...current, [kind]: undefined }));
  }
  const controllerLanes = (data?.lanes ?? []).filter((lane) => lane.site_id === controllerSiteId);
  const localLaneLabel = (local?.lane_ids ?? [])
    .map((id) => data?.lanes.find((lane) => lane.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const events = (isGuard ? (local?.events ?? data?.events) : data?.events) ?? [];
  const heartbeat = data?.heartbeats[0];
  const activeController = controllers
    .filter((controller) => controller.status === "active")
    .sort(
      (left, right) =>
        new Date(right.last_seen_at ?? 0).getTime() - new Date(left.last_seen_at ?? 0).getTime(),
    )[0];
  const controllerLastSeen = activeController?.last_seen_at ?? heartbeat?.received_at ?? null;
  const reportedConfigVersion =
    activeController?.config_version ?? heartbeat?.payload.config_version;
  const fresh = !!controllerLastSeen && Date.now() - new Date(controllerLastSeen).getTime() < 20000;
  const synced = fresh && reportedConfigVersion === data?.organization.config_version;
  const pending = isGuard
    ? local?.pending_events
    : (activeController?.pending_events ?? heartbeat?.payload.pending_events);
  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    const laneIds = form.getAll("lane_ids").map(String);
    const body: Record<string, unknown> = Object.fromEntries(form.entries());
    const propertyId = String(form.get("property_id") ?? "new");
    delete body.property_id;
    delete body.lane_ids;
    if (propertyId !== "new") {
      body.property_id = propertyId;
      delete body.resident;
      delete body.property;
    }
    // Omitting the list authorizes the credential at every lane in the village.
    if (laneIds.length) body.lane_ids = laneIds;
    try {
      await request("/enrollments", body);
      setEnrolling(false);
      setNotice("Vehicle enrolled. Gate access activates when the controller receives the update.");
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeStatus(v: Vehicle, status: string) {
    setStatusChange(null);
    if (!v.credential_id) {
      setNotice("This record has no credential to update.");
      return;
    }
    setBusy(true);
    try {
      if (isResident && status === "lost") {
        await request("/credential-requests", { credential_id: v.credential_id });
        setNotice("Loss reported. Gate status appears in your replacement request below.");
      } else {
        await request("/credentials/" + v.credential_id + "/status", { status });
        setNotice("Credential updated. Gate delivery is tracked separately.");
      }
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moveOutProperty) return;
    const form = new FormData(event.currentTarget);
    const localCutoff = String(form.get("effective_at") ?? "");
    setBusy(true);
    setNotice("");
    try {
      if (localCutoff) {
        const cutoff = new Date(`${localCutoff}:00+08:00`);
        if (!Number.isFinite(cutoff.getTime())) throw new Error("Enter a valid date and time.");
        const result = await request(`/properties/${moveOutProperty.id}/move-out-schedule`, {
          effective_at: cutoff.toISOString(),
          reason: moveOutReason.trim(),
        });
        const pending =
          Number(result.expected_controllers) - Number(result.acknowledged_controllers);
        setNotice(
          pending > 0
            ? `Move-out scheduled for ${formatWhen(result.effective_at)} Asia/Manila. ${pending} gate${pending === 1 ? "" : "s"} still need the configuration.`
            : `Move-out scheduled for ${formatWhen(result.effective_at)} Asia/Manila.`,
        );
      } else {
        const result = await request(`/properties/${moveOutProperty.id}/move-out`, {
          reason: moveOutReason.trim(),
        });
        const pending =
          Number(result.expected_controllers) - Number(result.acknowledged_controllers);
        setNotice(
          pending > 0
            ? `${moveOutProperty.label} access ended. Waiting for ${pending} controller${pending === 1 ? "" : "s"} to receive the change.`
            : `${moveOutProperty.label} access ended.`,
        );
      }
      setMoveOutProperty(null);
      setMoveOutReason("");
      setMoveOutEffectiveAt("");
      setHouseholdRefresh((current) => current + 1);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancelMoveOutSchedule(property: Property) {
    setBusy(true);
    setNotice("");
    try {
      const result = await request(`/properties/${property.id}/move-out-schedule/cancel`, {});
      setNotice(
        `Scheduled move-out cancelled. Gates will remove the cached cutoff when they receive configuration v${result.configuration_version}.`,
      );
      setHouseholdRefresh((current) => current + 1);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retireVehicle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!retirementVehicle) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    setBusy(true);
    setNotice("");
    try {
      if (isResident) {
        await request("/vehicle-retirement-requests", {
          vehicle_id: retirementVehicle.id,
          reason,
        });
        setNotice(
          `Your request to remove ${retirementVehicle.plate} was sent to the village office.`,
        );
      } else {
        const result = await request(`/vehicles/${retirementVehicle.id}/retire`, { reason });
        const pending =
          Number(result.expected_controllers) - Number(result.acknowledged_controllers);
        setNotice(
          pending > 0
            ? `${retirementVehicle.plate} access was removed. Waiting for ${pending} gate${pending === 1 ? "" : "s"} to receive the change.`
            : `${retirementVehicle.plate} access was removed.`,
        );
      }
      setRetirementVehicle(null);
      setRetirementReason("");
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decideVehicleRetirement(
    item: VehicleRetirementRequest,
    action: "approve" | "reject",
  ) {
    setBusy(true);
    setNotice("");
    try {
      await request(`/vehicle-retirement-requests/${item.id}/${action}`, {
        decision_note: "",
      });
      setNotice(
        action === "approve"
          ? `${item.plate} was retired. Other household vehicles remain active.`
          : `The request to remove ${item.plate} was declined.`,
      );
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function loadMoreHouseholdMembers(propertyId: string) {
    const current = memberPages[propertyId];
    setMemberPages((pages) => ({
      ...pages,
      [propertyId]: {
        items: current?.items ?? [],
        cursor: current?.cursor ?? null,
        loaded: !!current,
        busy: true,
      },
    }));
    setPagingMessage("");
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (current?.cursor) query.set("cursor", current.cursor);
      const page: { items: HouseholdMember[]; next_cursor: string | null } = await request(
        `/properties/${propertyId}/members?${query}`,
      );
      if (priorOrganizationKey.current !== organizationKey) return;
      setMemberPages((pages) => {
        const previous = current?.items ?? [];
        const combined: HouseholdMember[] = current ? [...previous, ...page.items] : page.items;
        return {
          ...pages,
          [propertyId]: {
            items: Array.from(
              new Map<string, HouseholdMember>(combined.map((item) => [item.id, item])).values(),
            ),
            cursor: page.next_cursor,
            loaded: true,
            busy: false,
          },
        };
      });
    } catch (issue) {
      setPagingMessage((issue as Error).message);
      setMemberPages((pages) => ({
        ...pages,
        [propertyId]: {
          items: current?.items ?? [],
          cursor: current?.cursor ?? null,
          loaded: !!current,
          busy: false,
        },
      }));
    }
  }
  async function loadMoreHouseholds() {
    const current = householdPage;
    if (!current?.cursor || householdLoading) return;
    const sequence = householdSequence.current;
    setHouseholdLoading(true);
    setPagingMessage("");
    try {
      const query = new URLSearchParams({
        search: current.search,
        limit: "50",
        cursor: current.cursor,
      });
      const page = await request(`/households?${query}`);
      if (
        sequence !== householdSequence.current ||
        current.search !== search ||
        organizationKey !== priorOrganizationKey.current
      )
        return;
      setHouseholdPage((previous) => {
        if (!previous || previous.search !== current.search) return previous;
        const combined = [...previous.items, ...page.items];
        return {
          search: current.search,
          items: Array.from(new Map(combined.map((item: Property) => [item.id, item])).values()),
          cursor: page.next_cursor,
        };
      });
    } catch (issue) {
      setPagingMessage((issue as Error).message);
    } finally {
      if (sequence === householdSequence.current) setHouseholdLoading(false);
    }
  }
  async function loadMoreLifecycle(kind: string, field: keyof Snapshot) {
    if (lifecycleBusy[kind]) return;
    setLifecycleBusy((current) => ({ ...current, [kind]: true }));
    setPagingMessage("");
    try {
      let cursor = lifecycleCursors[kind] ?? null;
      let page: any;
      let items: any[] = [];
      // The snapshot's first page remains useful; skip pages that contain only its already-shown rows.
      for (let attempt = 0; attempt < 20; attempt++) {
        const query = new URLSearchParams({ limit: "50" });
        if (kind !== "occupancies") query.set("kind", kind);
        const status = selectedLifecycleFilter(kind);
        if (status !== "all") query.set("status", status);
        if (cursor) query.set("cursor", cursor);
        page = await request(
          kind === "occupancies" ? `/occupancies?${query}` : `/lifecycle-requests?${query}`,
        );
        if (!active.current || priorOrganizationKey.current !== organizationKey) return;
        const pageItems = page.items;
        const refreshed = new Map<string, any>(pageItems.map((item: any) => [item.id, item]));
        setData((current) =>
          current
            ? {
                ...current,
                [field]: mergeRowsById(
                  ((current[field] as any[]) ?? []).map((row) => refreshed.get(row.id) ?? row),
                  pageItems,
                ),
              }
            : current,
        );
        cursor = page.next_cursor;
        const existing = new Set(
          (data?.[field] as any[] | undefined)?.map((item) => item.id) ?? [],
        );
        items = page.items.filter((item: any) => !existing.has(item.id));
        if (items.length || !cursor) break;
      }
      if (priorOrganizationKey.current !== organizationKey) return;
      setLifecycleCursors((current) => ({ ...current, [kind]: cursor }));
    } catch (issue) {
      setPagingMessage((issue as Error).message);
    } finally {
      setLifecycleBusy((current) => ({ ...current, [kind]: false }));
    }
  }
  async function issueCredentialReplacement(
    event: FormEvent<HTMLFormElement>,
    replacementRequest: CredentialRequest,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      await request(`/credential-requests/${replacementRequest.id}/issue`, {
        format: String(form.get("format") ?? "epc"),
        value: String(form.get("value") ?? "")
          .trim()
          .toUpperCase(),
      });
      setNotice(`Replacement tag issued for ${replacementRequest.plate}.`);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rejectCredentialReplacement(replacementRequest: CredentialRequest) {
    setBusy(true);
    setNotice("");
    try {
      await request(`/credential-requests/${replacementRequest.id}/reject`, {});
      setNotice(`Replacement request for ${replacementRequest.plate} was declined.`);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function requestVehicleCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionVehicle) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setNotice("");
    try {
      await request("/vehicle-change-requests", {
        vehicle_id: correctionVehicle.id,
        plate: String(form.get("plate") ?? "")
          .trim()
          .toUpperCase(),
        make: String(form.get("make") ?? "").trim(),
        color: String(form.get("color") ?? "").trim(),
      });
      setCorrectionVehicle(null);
      setNotice("Vehicle correction sent to your village office for review.");
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decideVehicleChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!vehicleDecision) return;
    const note = String(new FormData(event.currentTarget).get("decision_note") ?? "").trim();
    setBusy(true);
    setNotice("");
    try {
      await request(
        `/vehicle-change-requests/${vehicleDecision.request.id}/${vehicleDecision.action}`,
        { decision_note: note },
      );
      setNotice(
        vehicleDecision.action === "approve"
          ? "Vehicle details approved. Gate delivery appears in request status when needed."
          : "Vehicle correction declined.",
      );
      setVehicleDecision(null);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function endHouseholdMember(member: HouseholdMember) {
    if (!window.confirm(`Remove ${member.name} from this home? Their other homes stay available.`))
      return;
    setBusy(true);
    setNotice("");
    try {
      await request(`/properties/${member.property_id}/members/${member.id}/end`, {});
      setNotice(`${member.name} no longer has access to this home.`);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function makePrimaryContact(member: HouseholdMember) {
    setBusy(true);
    setNotice("");
    try {
      await request(`/properties/${member.property_id}/members/${member.id}/primary`, {});
      setNotice(`${member.name} is now the primary household contact.`);
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setNotice("");
    try {
      const created = await request("/sites", {
        name: String(values.get("site_name") ?? ""),
        code: String(values.get("site_code") ?? ""),
      });
      setControllerSiteId(created.site_id);
      setNotice("Site created. Add its lanes before enrolling a controller.");
      form.reset();
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function createLane(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const siteId = String(values.get("lane_site_id") ?? "");
    setBusy(true);
    setNotice("");
    try {
      await request("/sites/" + siteId + "/lanes", {
        name: String(values.get("lane_name") ?? ""),
        direction: String(values.get("direction") ?? "entry"),
      });
      setControllerSiteId(siteId);
      setNotice("Lane created. Assign it to a controller to make it operational.");
      form.reset();
      await load();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function issueControllerGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const laneIds = values.getAll("controller_lane_ids").map(String);
    if (!laneIds.length) {
      setNotice("Choose at least one lane for this controller.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const grant = await request("/controllers/enrollment-grants", {
        name: String(values.get("controller_name") ?? ""),
        site_id: String(values.get("controller_site_id") ?? ""),
        lane_ids: laneIds,
        expires_in_minutes: Number(values.get("expires_in_minutes") ?? 15),
      });
      setIssuedControllerGrant({
        name: grant.name,
        code: grant.enrollment_code,
        expiresAt: grant.expires_at,
      });
      setNotice("Enrollment code created. Copy it to the installer; it is shown only once.");
      await loadControllerManagement();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeControllerGrant(grant: ControllerGrant) {
    setBusy(true);
    try {
      await request("/controllers/enrollment-grants/" + grant.id + "/revoke", {});
      setNotice("Enrollment grant revoked.");
      await loadControllerManagement();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rotateControllerCredential(controller: Controller) {
    setBusy(true);
    try {
      const result = await request("/controllers/" + controller.id + "/rotate-credential", {});
      setRotatedControllerCredential({
        controllerId: controller.id,
        credential: result.credential,
      });
      setNotice("New credential created. The edge must be updated before it can sync again.");
      await loadControllerManagement();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeController(controller: Controller) {
    setBusy(true);
    try {
      await request("/controllers/" + controller.id + "/revoke", { reason: "revoked by HOA" });
      setNotice("Controller revoked. It can no longer fetch policy or upload events.");
      await loadControllerManagement();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function scan(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(EDGE + "/simulator/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: scanFormat, value: scanValue.trim().toUpperCase() }),
        signal: AbortSignal.timeout(3000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "Scan failed");
      setResult(value);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inviteStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    const role = String(form.get("role") ?? "guard");
    const body: Record<string, unknown> = { email: String(form.get("email") ?? ""), role };
    if (role === "guard") body.site_id = String(form.get("site_id") ?? "");
    if (role === "resident") {
      body.property_id = String(form.get("property_id") ?? "");
      const relationship = String(form.get("relationship") ?? "");
      if (relationship) body.relationship = relationship;
    }
    try {
      const created = await request("/invitations", body);
      setIssuedInvite({ email: created.email, role: created.role, token: created.token });
      setInviting(false);
      await loadStaff();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeInvitation(id: string) {
    setBusy(true);
    try {
      await request("/invitations/" + id + "/revoke", {});
      await loadStaff();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revokeMembership(id: string) {
    setBusy(true);
    try {
      await request("/memberships/" + id + "/revoke", {
        reason: "Removed from the village by an administrator",
      });
      setNotice("Access removed. The person's sessions ended immediately.");
      await loadStaff();
    } catch (issue) {
      setNotice((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const icon = (name: string) =>
    name.includes("vehicle") || name.includes("Vehicles") ? (
      <CarFront size={18} />
    ) : name.includes("Residents") ? (
      <Users size={18} />
    ) : name.includes("Staff") ? (
      <UserPlus size={18} />
    ) : name.includes("activity") ? (
      <Activity size={18} />
    ) : name.includes("devices") ? (
      <Radio size={18} />
    ) : name === "Help" ? (
      <CircleHelp size={18} />
    ) : isResident ? (
      <Home size={18} />
    ) : (
      <LayoutDashboard size={18} />
    );
  const showVehicles = ["Vehicles & RFID", "My vehicles"].includes(tab);
  const showEvents = ["Access activity", "My activity"].includes(tab);
  if (!session) return <LoginScreen mode={mode} auth={auth} />;
  if (auth.pendingInvitation) return <PendingInvitationScreen mode={mode} auth={auth} />;
  if (!session.principal.organizationId) return <OrganizationChooser mode={mode} auth={auth} />;
  const me = session.principal;
  const assignedSite =
    data?.sites.find((site) => me.sites.includes(site.id)) ?? data?.sites[0] ?? null;
  const roleLabel = me.supportGrantId
    ? "Support access · read only"
    : me.role === "resident"
      ? "Resident"
      : me.role === "guard"
        ? "Guard"
        : me.role === "hoa_admin"
          ? "Village administrator"
          : "Platform operator";
  const initials =
    me.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "SG";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace">
          <span className="workspace-icon">
            <Building2 size={19} />
          </span>
          <div>
            <strong>{data?.organization.name ?? "Your village"}</strong>
            <small>
              {isGuard
                ? (assignedSite?.name ?? "No station assigned") + " · Entry lane"
                : isResident
                  ? "Resident portal"
                  : "Village management"}
            </small>
          </div>
          <ChevronRight size={14} />
        </div>
        <p className="nav-label">
          {isResident ? "YOUR VILLAGE" : isGuard ? "ON DUTY" : "WORKSPACE"}
        </p>
        <nav aria-label="Main navigation">
          {nav.map((name) => (
            <button
              key={name}
              className={tab === name ? "nav-item selected" : "nav-item"}
              onClick={() => {
                setTab(name);
                setSearch("");
              }}
            >
              {icon(name)}
              <span>{name}</span>
              {tab === name && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card">
            <ShieldCheck size={20} />
            <strong>A thoughtful welcome.</strong>
            <p>Dependable access for the place you call home.</p>
          </div>
          <div className="account">
            <span className="avatar">{initials}</span>
            <div>
              <strong>{me.name}</strong>
              <small>{roleLabel}</small>
            </div>
            <button
              className="icon-button"
              onClick={() => void logout()}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Palm Grove</span>
            <ChevronRight size={13} />
            <strong>{tab}</strong>
          </div>
          <div className="top-actions">
            <Badge
              tone={
                isResident
                  ? "neutral"
                  : isGuard
                    ? local
                      ? "green"
                      : "amber"
                    : fresh
                      ? "green"
                      : "neutral"
              }
            >
              <span className="status-dot" />
              {isResident
                ? "Resident portal"
                : isGuard
                  ? local
                    ? "Local station connected"
                    : "Station unavailable"
                  : fresh
                    ? "Controller connected"
                    : "Awaiting controller"}
            </Badge>
            <button className="icon-button" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        {demoEnabled && (
          <div className="demo-banner">
            <span>DEVELOPMENT PREVIEW</span> Sample village · demonstration sign-in · simulated
            barrier
          </div>
        )}
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {isResident
                  ? "A LITTLE CLOSER TO HOME"
                  : isGuard
                    ? "PALM GROVE · MAIN ENTRANCE"
                    : "CONNECTED COMMUNITY"}
              </p>
              <h1>
                {tab === "Overview"
                  ? "Your village, at a glance."
                  : tab === "My home"
                    ? "Welcome home, Andrea."
                    : tab === "Gate station"
                      ? "Every arrival, a warm welcome."
                      : tab}
              </h1>
              <p className="subtitle">
                {isResident
                  ? "Your vehicles and access, in one quiet corner."
                  : isGuard
                    ? "Keep the entrance moving. Give every exception the attention it needs."
                    : "A clear view of your residents, vehicles, and village access."}
              </p>
            </div>
            {!isResident && !isGuard && (
              <button
                className="button primary"
                onClick={() => {
                  setEnrollmentPropertyId("new");
                  setEnrolling(true);
                }}
              >
                <Plus size={17} />
                Enroll a vehicle
              </button>
            )}
          </div>
          {error && (
            <div className="notice warning" role="status">
              <WifiOff size={17} />
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                className="icon-button"
                onClick={() => setNotice("")}
                aria-label="Dismiss notification"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {["Overview", "My home"].includes(tab) && (
            <>
              <section className="welcome-panel">
                <div>
                  <Badge tone="light">
                    <ShieldCheck size={13} />
                    ACCESS THAT FEELS LIKE HOME
                  </Badge>
                  <h2>
                    {isResident
                      ? "A smoother way\nto come home."
                      : "Good mornings start\nat the gate."}
                  </h2>
                  <p>
                    {isResident
                      ? "Your registered vehicle is recognized at the entrance. No app to open. Just arrive."
                      : "Less waiting. Clearer oversight. A welcoming entrance for the people who belong here."}
                  </p>
                  <button
                    className="text-button light-text"
                    onClick={() => setTab(isResident ? "My vehicles" : "Gates & devices")}
                  >
                    {isResident ? "View my vehicles" : "View gate status"}
                    <ArrowUpRight size={17} />
                  </button>
                </div>
                <div className="gate-illustration" aria-hidden="true">
                  <div className="arch arch-back" />
                  <div className="arch" />
                  <div className="gate-pillar" />
                  <div className="barrier-arm" />
                  <div className="road-line" />
                  <div className="tree tree-one" />
                  <div className="tree tree-two" />
                  <span className="illustration-label">PALM GROVE</span>
                </div>
              </section>
              <section className="stats">
                <Stat
                  icon={<CarFront />}
                  label={isResident ? "Your vehicles" : "Registered vehicles"}
                  value={data ? data.vehicles.length : "—"}
                  detail="Enrolled in this village"
                />
                <Stat
                  icon={<ShieldCheck />}
                  label="Active credentials"
                  value={
                    data
                      ? data.vehicles.filter((v) => v.credential_status === "active").length
                      : "—"
                  }
                  detail="Cloud authorization status"
                />
                <Stat
                  icon={<Activity />}
                  label="Recorded attempts"
                  value={data ? data.events.length : "—"}
                  detail="Latest 100 synchronized events"
                />
                {!isResident && (
                  <Stat
                    icon={<Radio />}
                    label="Gate configuration"
                    value={synced ? "Synced" : fresh ? "Updating" : "Pending"}
                    detail={
                      fresh
                        ? "Controller version " + heartbeat?.payload.config_version
                        : "Waiting for acknowledgement"
                    }
                  />
                )}
              </section>
              <div className="two-columns">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>{isResident ? "Your vehicles" : "Registered vehicles"}</h3>
                      <p>Credentials linked to a home.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setTab(isResident ? "My vehicles" : "Vehicles & RFID")}
                    >
                      View all
                      <ChevronRight size={15} />
                    </button>
                  </div>
                  {vehicles.slice(0, 3).map((v) => (
                    <div className="vehicle-summary" key={v.id}>
                      <div className="vehicle-icon">
                        <CarFront size={25} />
                      </div>
                      <div>
                        <strong>{v.make}</strong>
                        <p>
                          {v.plate} <span>·</span> {v.color}
                        </p>
                      </div>
                      <Badge tone={v.credential_status === "active" ? "green" : "amber"}>
                        {v.credential_status}
                      </Badge>
                    </div>
                  ))}
                  {!vehicles.length && <Empty text="Vehicles will appear here after enrollment." />}
                </section>
                <section className="panel gate-card">
                  <div className="panel-heading">
                    <div>
                      <h3>{isResident ? "A note about your access" : "Main gate"}</h3>
                      <p>
                        {isResident
                          ? "Designed around your everyday."
                          : "Entry lane · Hikvision pilot target"}
                      </p>
                    </div>
                    <DoorOpen size={22} />
                  </div>
                  <div className="gate-health">
                    <span className={"health-orb " + (fresh ? "connected" : "")}>
                      {fresh ? <Wifi size={22} /> : <Radio size={22} />}
                    </span>
                    <div>
                      <strong>
                        {isResident
                          ? "Your RFID works without your phone"
                          : fresh
                            ? "Controller reporting"
                            : "Waiting for the local controller"}
                      </strong>
                      <p>
                        {isResident
                          ? "Lost a tag? Report it from your vehicle card."
                          : fresh
                            ? "Hardware mode: simulation"
                            : "Gate configuration and event delivery appear after connection."}
                      </p>
                    </div>
                  </div>
                  <div className="panel-foot">
                    {isResident
                      ? "Status changes reach each gate after synchronization."
                      : "Physical commissioning is required before a live pilot."}
                  </div>
                </section>
              </div>
              {isResident &&
                residentProperties
                  .filter((property) => property.scheduled_move_out_at)
                  .map((property) => (
                    <section className="panel" key={property.scheduled_move_out_id}>
                      <div className="panel-heading">
                        <div>
                          <h3>Scheduled household move-out</h3>
                          <p>
                            {property.label} · {formatWhen(property.scheduled_move_out_at)}{" "}
                            Asia/Manila
                          </p>
                        </div>
                        <Badge tone="amber">Cutoff scheduled</Badge>
                      </div>
                      <p>
                        Gates enforce the cutoff after they receive this schedule.{" "}
                        {Number(property.scheduled_acknowledged_controllers ?? 0)} of{" "}
                        {Number(property.scheduled_expected_controllers ?? 0)} assigned gates have
                        received it. An offline gate that has not received the schedule may need
                        follow-up.
                      </p>
                    </section>
                  ))}
              <EventTable
                events={events.slice(0, 5)}
                onAll={() => setTab(isResident ? "My activity" : "Access activity")}
              />
            </>
          )}
          {showVehicles && (
            <>
              {(data?.vehicle_retirement_requests?.length ?? 0) > 0 && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>
                        {isResident ? "Vehicle removal request status" : "Vehicle removal requests"}
                      </h3>
                      <p>
                        Removing one vehicle ends only that vehicle's access. Household members and
                        other vehicles stay active.
                      </p>
                    </div>
                  </div>
                  <div className="replacement-actions" aria-label="Filter vehicle removal requests">
                    {(["all", "pending", "resolved"] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className="text-button"
                        aria-pressed={selectedLifecycleFilter("vehicle_retirements") === filter}
                        onClick={() => chooseLifecycleFilter("vehicle_retirements", filter)}
                      >
                        {filter === "all" ? "All" : filter === "pending" ? "Pending" : "Resolved"}
                      </button>
                    ))}
                  </div>
                  {filterLifecycleItems(
                    "vehicle_retirements",
                    data!.vehicle_retirement_requests,
                  ).map((item) => (
                    <div className="vehicle-summary" key={item.id}>
                      <div className="vehicle-icon">
                        <CarFront size={22} />
                      </div>
                      <div className="replacement-request-details">
                        <strong>
                          {item.plate} · {item.property_label}
                        </strong>
                        <p>
                          {item.reason || "No reason provided"} · {formatWhen(item.created_at)}
                        </p>
                        <p>{retirementDeliveryLabel(item)}</p>
                        {item.decision_note && item.status !== "pending" && (
                          <small>{item.decision_note}</small>
                        )}
                        {canManageCredentials && item.status === "pending" && (
                          <div className="replacement-actions">
                            <button
                              className="button primary"
                              disabled={busy}
                              onClick={() => void decideVehicleRetirement(item, "approve")}
                            >
                              Approve removal
                            </button>
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() => void decideVehicleRetirement(item, "reject")}
                            >
                              Decline
                            </button>
                          </div>
                        )}
                      </div>
                      <Badge
                        tone={
                          item.status === "approved"
                            ? "green"
                            : item.status === "pending"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {item.status === "approved"
                          ? "Removed"
                          : item.status === "pending"
                            ? "In review"
                            : item.status}
                      </Badge>
                    </div>
                  ))}
                  {!filterLifecycleItems("vehicle_retirements", data!.vehicle_retirement_requests)
                    .length && <Empty text="No requests in this view." />}
                  {lifecycleCursors.vehicle_retirements !== null && (
                    <button
                      className="text-button"
                      disabled={lifecycleBusy.vehicle_retirements}
                      onClick={() =>
                        void loadMoreLifecycle("vehicle_retirements", "vehicle_retirement_requests")
                      }
                    >
                      {lifecycleBusy.vehicle_retirements
                        ? "Loading older requests…"
                        : "Load older removal requests"}
                    </button>
                  )}
                </section>
              )}
              {isResident && (data?.credential_requests.length ?? 0) > 0 && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Replacement request status</h3>
                      <p>Track review status and gate acknowledgement for your lost tag.</p>
                    </div>
                  </div>
                  <div className="replacement-actions" aria-label="Filter replacement requests">
                    {(["all", "pending", "resolved"] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className="text-button"
                        aria-pressed={selectedLifecycleFilter("credential_replacements") === filter}
                        onClick={() => chooseLifecycleFilter("credential_replacements", filter)}
                      >
                        {filter === "all" ? "All" : filter === "pending" ? "Pending" : "Resolved"}
                      </button>
                    ))}
                  </div>
                  {filterLifecycleItems("credential_replacements", data!.credential_requests).map(
                    (replacementRequest) => (
                      <div className="vehicle-summary" key={replacementRequest.id}>
                        <div className="vehicle-icon">
                          <CarFront size={22} />
                        </div>
                        <div className="replacement-request-details">
                          <strong>{replacementRequest.plate}</strong>
                          <p>
                            {replacementRequest.status === "pending"
                              ? "Waiting for village review. "
                              : replacementRequest.status === "issued"
                                ? "Replacement issued. "
                                : "Request declined. "}
                            {deliveryLabel(replacementRequest)}
                          </p>
                          {replacementRequest.status === "rejected" &&
                            replacementRequest.decision_note && (
                              <small>{replacementRequest.decision_note}</small>
                            )}
                        </div>
                        <Badge
                          tone={
                            replacementRequest.status === "issued"
                              ? "green"
                              : replacementRequest.status === "pending"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {replacementRequest.status === "issued"
                            ? "Replacement issued"
                            : replacementRequest.status === "pending"
                              ? "In review"
                              : "Declined"}
                        </Badge>
                      </div>
                    ),
                  )}
                  {lifecycleCursors.credential_replacements !== null && (
                    <button
                      className="text-button"
                      disabled={lifecycleBusy.credential_replacements}
                      onClick={() =>
                        void loadMoreLifecycle("credential_replacements", "credential_requests")
                      }
                    >
                      {lifecycleBusy.credential_replacements
                        ? "Loading older requests…"
                        : "Load older replacement requests"}
                    </button>
                  )}
                </section>
              )}
              {canManageCredentials && (data?.credential_requests.length ?? 0) > 0 && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Credential replacement requests</h3>
                      <p>Issue a new tag without reactivating the lost one.</p>
                    </div>
                  </div>
                  {data!.credential_requests.map((replacementRequest) => (
                    <div className="vehicle-summary" key={replacementRequest.id}>
                      <div className="vehicle-icon">
                        <CarFront size={22} />
                      </div>
                      <div className="replacement-request-details">
                        <strong>
                          {replacementRequest.plate} · {replacementRequest.property_label}
                        </strong>
                        <p>
                          {replacementRequest.resident_name} ·{" "}
                          {formatWhen(replacementRequest.created_at)}
                        </p>
                        <p>{deliveryLabel(replacementRequest)}</p>
                        {replacementRequest.status === "pending" ? (
                          <form
                            className="replacement-form"
                            onSubmit={(event) =>
                              void issueCredentialReplacement(event, replacementRequest)
                            }
                          >
                            <label>
                              New tag format
                              <select name="format" defaultValue="epc">
                                <option value="epc">EPC / UHF</option>
                                <option value="wiegand26">Wiegand 26 payload</option>
                                <option value="wiegand34">Wiegand 34 payload</option>
                              </select>
                            </label>
                            <label>
                              New tag value
                              <input
                                name="value"
                                required
                                maxLength={64}
                                pattern="[0-9A-Fa-f]+"
                                className="mono"
                              />
                            </label>
                            <div className="replacement-actions">
                              <button className="button primary" disabled={busy}>
                                Issue replacement
                              </button>
                              <button
                                type="button"
                                className="button secondary"
                                disabled={busy}
                                onClick={() => void rejectCredentialReplacement(replacementRequest)}
                              >
                                Decline
                              </button>
                            </div>
                          </form>
                        ) : (
                          <p>
                            {replacementRequest.status === "issued"
                              ? "Replacement issued " + formatWhen(replacementRequest.resolved_at)
                              : "Declined " + formatWhen(replacementRequest.resolved_at)}
                            {replacementRequest.decision_note
                              ? " · " + replacementRequest.decision_note
                              : ""}
                          </p>
                        )}
                      </div>
                      <Badge
                        tone={
                          replacementRequest.status === "issued"
                            ? "green"
                            : replacementRequest.status === "pending"
                              ? "amber"
                              : "neutral"
                        }
                      >
                        {replacementRequest.status === "issued"
                          ? "Issued"
                          : replacementRequest.status === "pending"
                            ? "Pending review"
                            : "Declined"}
                      </Badge>
                    </div>
                  ))}
                </section>
              )}
              {(data?.vehicle_change_requests?.length ?? 0) > 0 && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>
                        {isResident ? "Vehicle correction status" : "Vehicle correction requests"}
                      </h3>
                      <p>
                        Changes to registered vehicle details are reviewed by the village office.
                      </p>
                    </div>
                  </div>
                  <div
                    className="replacement-actions"
                    aria-label="Filter vehicle correction requests"
                  >
                    {(["all", "pending", "resolved"] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className="text-button"
                        aria-pressed={selectedLifecycleFilter("vehicle_changes") === filter}
                        onClick={() => chooseLifecycleFilter("vehicle_changes", filter)}
                      >
                        {filter === "all" ? "All" : filter === "pending" ? "Pending" : "Resolved"}
                      </button>
                    ))}
                  </div>
                  {filterLifecycleItems("vehicle_changes", data?.vehicle_change_requests ?? []).map(
                    (change) => (
                      <div className="vehicle-summary" key={change.id}>
                        <div className="vehicle-icon">
                          <CarFront size={22} />
                        </div>
                        <div className="replacement-request-details">
                          <strong>
                            {change.prior_plate} · {change.property_label}
                          </strong>
                          <p>
                            Requested: {change.proposed_plate} · {change.proposed_make} ·{" "}
                            {change.proposed_color}
                          </p>
                          <small>Submitted {formatWhen(change.created_at)}</small>
                          <p>{vehicleChangeDeliveryLabel(change)}</p>
                          {change.decision_note && <small>{change.decision_note}</small>}
                          {canManageCredentials && change.status === "pending" && (
                            <div className="replacement-actions">
                              <button
                                className="button primary"
                                disabled={busy}
                                onClick={() =>
                                  setVehicleDecision({ request: change, action: "approve" })
                                }
                              >
                                Approve correction
                              </button>
                              <button
                                className="button secondary"
                                disabled={busy}
                                onClick={() =>
                                  setVehicleDecision({ request: change, action: "reject" })
                                }
                              >
                                Decline
                              </button>
                            </div>
                          )}
                        </div>
                        <Badge
                          tone={
                            change.status === "approved"
                              ? "green"
                              : change.status === "pending"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {change.status === "pending"
                            ? "In review"
                            : change.status === "approved"
                              ? "Approved"
                              : change.status === "cancelled"
                                ? "Cancelled"
                                : "Declined"}
                        </Badge>
                      </div>
                    ),
                  )}
                  {lifecycleCursors.vehicle_changes !== null && (
                    <button
                      className="text-button"
                      disabled={lifecycleBusy.vehicle_changes}
                      onClick={() =>
                        void loadMoreLifecycle("vehicle_changes", "vehicle_change_requests")
                      }
                    >
                      {lifecycleBusy.vehicle_changes
                        ? "Loading older requests…"
                        : "Load older correction requests"}
                    </button>
                  )}
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>{isResident ? "Vehicles at your home" : "Vehicles & credentials"}</h3>
                    <p>Manage access with a clear record of every change.</p>
                  </div>
                  <SearchBox value={search} onChange={setSearch} />
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Vehicle</th>
                        <th>Home / resident</th>
                        <th>Credential</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vehicles.map((v) => {
                        const openRequest = data?.credential_requests.some(
                          (replacementRequest) =>
                            replacementRequest.credential_id === v.credential_id &&
                            replacementRequest.status === "pending",
                        );
                        const pendingCorrection = data?.vehicle_change_requests?.some(
                          (change) => change.vehicle_id === v.id && change.status === "pending",
                        );
                        const retirement = data?.vehicle_retirement_requests?.find(
                          (item) => item.vehicle_id === v.id && item.status === "pending",
                        );
                        return (
                          <tr key={v.id}>
                            <td>
                              <strong>{v.plate}</strong>
                              <small>
                                {v.make} · {v.color}
                              </small>
                            </td>
                            <td>
                              {v.resident_name}
                              <small>{v.property_label}</small>
                            </td>
                            <td>
                              <span className="mono">{v.credential_value}</span>
                              <small>{v.format?.toUpperCase()}</small>
                            </td>
                            <td>
                              <Badge tone={v.credential_status === "active" ? "green" : "amber"}>
                                {v.credential_status}
                              </Badge>
                            </td>
                            <td>
                              <div className="replacement-actions">
                                {isResident &&
                                ["active", "suspended", "lost"].includes(
                                  v.credential_status ?? "",
                                ) ? (
                                  <button
                                    className="text-button"
                                    disabled={busy || openRequest}
                                    onClick={() => setStatusChange({ vehicle: v, status: "lost" })}
                                  >
                                    {openRequest
                                      ? "Request pending"
                                      : v.credential_status === "lost"
                                        ? "Request replacement"
                                        : "Report lost"}
                                  </button>
                                ) : !isResident &&
                                  ["active", "suspended"].includes(v.credential_status ?? "") ? (
                                  <button
                                    className="text-button"
                                    disabled={busy}
                                    onClick={() =>
                                      setStatusChange({
                                        vehicle: v,
                                        status:
                                          v.credential_status === "active" ? "suspended" : "active",
                                      })
                                    }
                                  >
                                    {v.credential_status === "active" ? "Suspend" : "Reactivate"}
                                  </button>
                                ) : (
                                  <span className="muted">Replacement required</span>
                                )}
                                {isResident && (
                                  <button
                                    className="text-button"
                                    disabled={busy || pendingCorrection}
                                    onClick={() => setCorrectionVehicle(v)}
                                  >
                                    {pendingCorrection
                                      ? "Correction pending"
                                      : "Request correction"}
                                  </button>
                                )}
                                {v.active && (isResident || canManageCredentials) && (
                                  <button
                                    className="text-button"
                                    disabled={busy || !!retirement}
                                    onClick={() => {
                                      setRetirementVehicle(v);
                                      setRetirementReason("");
                                    }}
                                  >
                                    {retirement
                                      ? "Removal request pending"
                                      : isResident
                                        ? "Report sold or removed"
                                        : "Remove vehicle"}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!vehicles.length && <Empty text="No matching vehicles." />}
              </section>
            </>
          )}
          {tab === "Residents" && (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>Homes in your village</h3>
                    <p>Property and resident records for the current village.</p>
                  </div>
                  <SearchBox value={search} onChange={setSearch} />
                </div>
                {residentProperties.map((property) => (
                  <div className="resident-row" key={property.id}>
                    <span className="avatar">
                      <Home size={18} />
                    </span>
                    <div className="resident-details">
                      <strong>{property.resident_name}</strong>
                      <p>{property.label}</p>
                      {property.occupancy_started_at && (
                        <small>Occupancy since {formatWhen(property.occupancy_started_at)}</small>
                      )}
                    </div>
                    <Badge tone={property.occupancy_id ? "green" : "neutral"}>
                      {property.occupancy_id ? "Occupied" : "Vacant"}
                    </Badge>
                    <Badge>
                      {
                        (data?.vehicles ?? []).filter(
                          (vehicle) => vehicle.property_id === property.id,
                        ).length
                      }{" "}
                      vehicle(s)
                    </Badge>
                    {property.scheduled_move_out_at && (
                      <small className="muted">
                        Move-out scheduled {formatWhen(property.scheduled_move_out_at)} Asia/Manila
                        ·{Number(property.scheduled_acknowledged_controllers ?? 0)}/
                        {Number(property.scheduled_expected_controllers ?? 0)} gates received it
                      </small>
                    )}
                    {canManageCredentials && property.occupancy_id && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => {
                          setMoveOutProperty(property);
                          setMoveOutReason("");
                          setMoveOutEffectiveAt(
                            manilaDateTimeInput(property.scheduled_move_out_at),
                          );
                        }}
                      >
                        {property.scheduled_move_out_at
                          ? "Change move-out"
                          : "End or schedule access"}
                      </button>
                    )}
                    {canManageCredentials &&
                      property.occupancy_id &&
                      property.scheduled_move_out_id && (
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => void cancelMoveOutSchedule(property)}
                        >
                          Cancel schedule
                        </button>
                      )}
                  </div>
                ))}
                {!residentProperties.length && <Empty text="No homes match this search." />}
                {canManageCredentials && householdLoading && (
                  <p className="muted">Searching households…</p>
                )}
                {canManageCredentials &&
                  householdPage?.search === search &&
                  householdPage.cursor && (
                    <button
                      className="text-button"
                      disabled={householdLoading}
                      onClick={() => void loadMoreHouseholds()}
                    >
                      {householdLoading ? "Loading more homes…" : "Load more households"}
                    </button>
                  )}
                {pagingMessage && (
                  <div className="notice warning" role="status">
                    {pagingMessage}
                  </div>
                )}
              </section>
              {canManageCredentials && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Household people</h3>
                      <p>
                        Manage each home separately. Removing someone here keeps their other homes.
                      </p>
                    </div>
                  </div>
                  {residentProperties
                    .filter((property) => property.occupancy_id)
                    .map((property) => {
                      const householdMembers = mergeRowsById(
                        data?.property_members?.filter(
                          (member) => member.property_id === property.id,
                        ) ?? [],
                        memberPages[property.id]?.items ?? [],
                      );
                      const currentMembers = householdMembers.filter(
                        (member) =>
                          member.occupancy_id === property.occupancy_id && !member.ended_at,
                      );
                      const formerMembers = householdMembers.filter(
                        (member) => member.property_id === property.id && member.ended_at,
                      );
                      return (
                        <div key={property.id} className="household-roster">
                          <div className="panel-heading">
                            <div>
                              <h4>{property.label}</h4>
                              <p>{property.resident_name}</p>
                            </div>
                            <button
                              className="button secondary"
                              onClick={() => {
                                setInviteRole("resident");
                                setInvitePropertyId(property.id);
                                setInviting(true);
                              }}
                            >
                              Invite person
                            </button>
                          </div>
                          {currentMembers.map((member) => (
                            <div className="vehicle-summary" key={member.id}>
                              <span className="avatar">
                                <Users size={17} />
                              </span>
                              <div className="replacement-request-details">
                                <strong>{member.name}</strong>
                                <p>
                                  {member.email} · {member.relationship.replaceAll("_", " ")}
                                </p>
                                <small>Since {formatWhen(member.started_at)}</small>
                              </div>
                              {member.is_primary_contact && <Badge tone="green">Primary</Badge>}
                              <div className="replacement-actions">
                                {!member.is_primary_contact && (
                                  <button
                                    className="text-button"
                                    disabled={busy}
                                    onClick={() => void makePrimaryContact(member)}
                                  >
                                    Make primary
                                  </button>
                                )}
                                <button
                                  className="text-button"
                                  disabled={busy}
                                  onClick={() => void endHouseholdMember(member)}
                                >
                                  Remove from home
                                </button>
                              </div>
                            </div>
                          ))}
                          {!currentMembers.length && (
                            <p className="muted">No active people on record.</p>
                          )}
                          {!!formerMembers.length && (
                            <details>
                              <summary>Former household members ({formerMembers.length})</summary>
                              {formerMembers.map((member) => (
                                <p key={member.id} className="muted">
                                  {member.name} · {member.relationship.replaceAll("_", " ")} · ended{" "}
                                  {formatWhen(member.ended_at)}
                                </p>
                              ))}
                            </details>
                          )}
                          <button
                            className="text-button"
                            disabled={
                              memberPages[property.id]?.busy ||
                              (!!memberPages[property.id]?.loaded &&
                                !memberPages[property.id]?.cursor)
                            }
                            onClick={() => void loadMoreHouseholdMembers(property.id)}
                          >
                            {memberPages[property.id]?.busy
                              ? "Loading household history…"
                              : !memberPages[property.id]?.loaded
                                ? "Load complete household history"
                                : memberPages[property.id]?.cursor
                                  ? "Load older household members"
                                  : "Household history loaded"}
                          </button>
                        </div>
                      );
                    })}
                  {!residentProperties.some((property) => property.occupancy_id) && (
                    <Empty text="No active households match this search." />
                  )}
                  {pagingMessage && (
                    <div className="notice warning" role="status">
                      {pagingMessage}
                    </div>
                  )}
                </section>
              )}
              {(data?.scheduled_move_outs?.length ?? 0) > 0 && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Scheduled move-outs</h3>
                      <p>Schedules and changes waiting for the assigned gates.</p>
                    </div>
                  </div>
                  <div className="replacement-actions" aria-label="Filter scheduled move-outs">
                    {(["all", "pending", "resolved"] as const).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className="text-button"
                        aria-pressed={selectedLifecycleFilter("move_outs") === filter}
                        onClick={() => chooseLifecycleFilter("move_outs", filter)}
                      >
                        {filter === "all"
                          ? "All"
                          : filter === "pending"
                            ? "Scheduled"
                            : "Completed or cancelled"}
                      </button>
                    ))}
                  </div>
                  {filterLifecycleItems("move_outs", data!.scheduled_move_outs).map((schedule) => (
                    <div className="vehicle-summary" key={schedule.id}>
                      <div className="vehicle-icon">
                        <Home size={20} />
                      </div>
                      <div className="replacement-request-details">
                        <strong>
                          {schedule.property_label} · {schedule.resident_name}
                        </strong>
                        <p>
                          {schedule.status} · cutoff {formatWhen(schedule.effective_at)} Asia/Manila
                          · revision {schedule.revision}
                        </p>
                        <p>
                          {Number(schedule.expected_controllers) === 0
                            ? "No active gate was assigned to the schedule."
                            : `${Number(schedule.acknowledged_controllers)} of ${Number(schedule.expected_controllers)} assigned gates have received revision ${schedule.revision}.`}
                        </p>
                        {Number(schedule.retry_count) > 0 && (
                          <p role="status">
                            Processing overdue · {schedule.retry_count} attempt
                            {Number(schedule.retry_count) === 1 ? "" : "s"}
                            {schedule.next_attempt_at
                              ? ` · retry after ${formatWhen(schedule.next_attempt_at)}`
                              : ""}
                          </p>
                        )}
                        {schedule.last_processing_error && (
                          <p className="muted">
                            Last processing error: {schedule.last_processing_error}
                          </p>
                        )}
                      </div>
                      <Badge tone={schedule.status === "scheduled" ? "amber" : "neutral"}>
                        {schedule.status === "scheduled" ? "Active schedule" : schedule.status}
                      </Badge>
                    </div>
                  ))}
                  {lifecycleCursors.move_outs !== null && (
                    <button
                      className="text-button"
                      disabled={lifecycleBusy.move_outs}
                      onClick={() => void loadMoreLifecycle("move_outs", "scheduled_move_outs")}
                    >
                      {lifecycleBusy.move_outs
                        ? "Loading older schedules…"
                        : "Load older schedules"}
                    </button>
                  )}
                </section>
              )}
              {canManageCredentials && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Move-out delivery</h3>
                      <p>Track when assigned gates have received each household access change.</p>
                    </div>
                  </div>
                  {data!.occupancies
                    .filter((occupancy) => occupancy.ended_at)
                    .map((occupancy) => (
                      <div className="vehicle-summary" key={occupancy.id}>
                        <div className="vehicle-icon">
                          <Home size={20} />
                        </div>
                        <div className="replacement-request-details">
                          <strong>
                            {occupancy.property_label} · {occupancy.resident_name}
                          </strong>
                          <p>
                            {occupancy.occupant_names.join(", ") || occupancy.resident_name} · moved
                            out {formatWhen(occupancy.ended_at)}
                          </p>
                          {occupancy.end_reason && <small>{occupancy.end_reason}</small>}
                          <p>{occupancyDeliveryLabel(occupancy)}</p>
                        </div>
                        <Badge
                          tone={
                            Number(occupancy.expected_controllers) === 0
                              ? "neutral"
                              : Number(occupancy.acknowledged_controllers) >=
                                  Number(occupancy.expected_controllers)
                                ? "green"
                                : "amber"
                          }
                        >
                          {Number(occupancy.expected_controllers) === 0
                            ? "No active gate"
                            : Number(occupancy.acknowledged_controllers) >=
                                Number(occupancy.expected_controllers)
                              ? "Delivered"
                              : "Pending gates"}
                        </Badge>
                      </div>
                    ))}
                  {!data!.occupancies.some((occupancy) => occupancy.ended_at) && (
                    <Empty text="No household move-outs have been recorded." />
                  )}
                  {lifecycleCursors.occupancies !== null && (
                    <button
                      className="text-button"
                      disabled={lifecycleBusy.occupancies}
                      onClick={() => void loadMoreLifecycle("occupancies", "occupancies")}
                    >
                      {lifecycleBusy.occupancies
                        ? "Loading older move-outs…"
                        : "Load older move-out records"}
                    </button>
                  )}
                </section>
              )}
            </>
          )}
          {tab === "Staff & access" && (
            <>
              {issuedInvite && (
                <section className="panel invite-issued">
                  <div className="panel-heading">
                    <div>
                      <p className="eyebrow">INVITATION READY</p>
                      <h3>Deliver this to {issuedInvite.email}</h3>
                      <p>
                        Outbound email is not configured yet, so the invitation is shown once here.
                        It works for one sign-up and expires in seven days.
                      </p>
                    </div>
                    <button
                      className="icon-button"
                      onClick={() => setIssuedInvite(null)}
                      aria-label="Dismiss invitation"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  <p className="mono invite-token">{issuedInvite.token}</p>
                </section>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>People with access</h3>
                    <p>
                      Members of {data?.organization.name ?? "this village"} and what they may do.
                    </p>
                  </div>
                  <button className="button primary" onClick={() => setInviting(true)}>
                    <UserPlus size={17} />
                    Invite someone
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {memberships.map((person) => (
                        <tr key={person.id}>
                          <td>
                            <strong>{person.name}</strong>
                            <small>{person.email}</small>
                          </td>
                          <td>{person.role.replace("_", " ")}</td>
                          <td>
                            <Badge tone={person.status === "active" ? "green" : "amber"}>
                              {person.status}
                            </Badge>
                          </td>
                          <td>
                            {person.status === "active" &&
                            person.id !== session.principal.membershipId ? (
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => void revokeMembership(person.id)}
                              >
                                Remove access
                              </button>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!memberships.length && <Empty text="No members yet." />}
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>Invitations</h3>
                    <p>Single-use invitations that have not been accepted yet.</p>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Invited</th>
                        <th>Role</th>
                        <th>Expires</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invitations.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.email}</strong>
                          </td>
                          <td>{row.role.replace("_", " ")}</td>
                          <td>
                            {new Date(row.expires_at).toLocaleDateString("en-PH", {
                              month: "short",
                              day: "numeric",
                            })}
                            <small>
                              {row.accepted_at
                                ? "Accepted"
                                : row.revoked_at
                                  ? "Revoked"
                                  : "Awaiting acceptance"}
                            </small>
                          </td>
                          <td>
                            {!row.accepted_at && !row.revoked_at ? (
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => void revokeInvitation(row.id)}
                              >
                                Revoke
                              </button>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!invitations.length && <Empty text="No invitations are outstanding." />}
              </section>
            </>
          )}
          {showEvents && <EventTable events={events} />}
          {tab === "Gates & devices" && (
            <>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h3>Controller status</h3>
                    <p>
                      Cloud authorization and controller acknowledgement are tracked independently.
                    </p>
                  </div>
                  <Badge tone={synced ? "green" : "amber"}>
                    {synced ? "Configuration synchronized" : "Awaiting synchronization"}
                  </Badge>
                </div>
                <div className="device-grid">
                  <Device
                    label="Cloud configuration"
                    value={"Version " + (data?.organization.config_version ?? "—")}
                  />
                  <Device
                    label="Controller acknowledgement"
                    value={
                      fresh
                        ? "Version " + heartbeat?.payload.config_version
                        : "Not received recently"
                    }
                  />
                  <Device label="Events awaiting upload" value={pending ?? "Unknown"} />
                  <Device
                    label="Current hardware mode"
                    value={activeController?.hardware_mode ?? "Simulator"}
                  />
                </div>
                <div className="hardware-list">
                  <h3>First supported hardware target</h3>
                  <p>
                    DS-TRI900-1/A reader · DS-TME200-D/P controller · DS-TMG320 barrier · DS-TMG035
                    radar
                  </p>
                  <p className="muted">
                    Exact regional models, protocol access, wiring, and commissioning remain to be
                    verified.
                  </p>
                </div>
              </section>
              <section className="panel controller-management">
                <div className="panel-heading">
                  <div>
                    <h3>Site and lane setup</h3>
                    <p>Create the site topology before assigning an edge controller.</p>
                  </div>
                </div>
                {canManageDevices ? (
                  <div className="two-columns controller-tools">
                    <form className="management-form" onSubmit={createSite}>
                      <h4>Add a site</h4>
                      <label>
                        Site name
                        <input
                          name="site_name"
                          required
                          maxLength={80}
                          placeholder="North entrance"
                        />
                      </label>
                      <label>
                        Short code
                        <input name="site_code" required maxLength={16} placeholder="NORTH" />
                      </label>
                      <button className="button secondary" disabled={busy}>
                        Create site
                      </button>
                    </form>
                    <form className="management-form" onSubmit={createLane}>
                      <h4>Add a lane</h4>
                      <label>
                        Site
                        <select
                          name="lane_site_id"
                          value={controllerSiteId}
                          onChange={(event) => setControllerSiteId(event.target.value)}
                          required
                        >
                          {(data?.sites ?? []).map((site) => (
                            <option key={site.id} value={site.id}>
                              {site.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Lane name
                        <input
                          name="lane_name"
                          required
                          maxLength={80}
                          placeholder="Resident entry"
                        />
                      </label>
                      <label>
                        Direction
                        <select name="direction" defaultValue="entry">
                          <option value="entry">Entry</option>
                          <option value="exit">Exit</option>
                          <option value="bidirectional">Bidirectional</option>
                        </select>
                      </label>
                      <button className="button secondary" disabled={busy || !data?.sites.length}>
                        Create lane
                      </button>
                    </form>
                  </div>
                ) : (
                  <p className="muted controller-note">
                    Your role can view controllers but cannot change site setup.
                  </p>
                )}
              </section>
              <section className="panel controller-management">
                <div className="panel-heading">
                  <div>
                    <h3>Edge controllers</h3>
                    <p>Enrollment codes are single-use, expire quickly, and are shown once.</p>
                  </div>
                </div>
                {canManageDevices && (
                  <form
                    className="management-form controller-enrollment-form"
                    onSubmit={issueControllerGrant}
                  >
                    <label>
                      Controller name
                      <input
                        name="controller_name"
                        required
                        maxLength={80}
                        placeholder="North entry controller"
                      />
                    </label>
                    <label>
                      Site
                      <select
                        name="controller_site_id"
                        value={controllerSiteId}
                        onChange={(event) => setControllerSiteId(event.target.value)}
                        required
                      >
                        {(data?.sites ?? []).map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Code expires in
                      <select name="expires_in_minutes" defaultValue="15">
                        <option value="15">15 minutes</option>
                        <option value="30">30 minutes</option>
                        <option value="60">60 minutes</option>
                      </select>
                    </label>
                    <div className="lane-check-list">
                      <strong>Assigned lanes</strong>
                      {controllerLanes.map((lane) => (
                        <label className="lane-option" key={lane.id}>
                          <input type="checkbox" name="controller_lane_ids" value={lane.id} />
                          <span>
                            {lane.name} · {lane.direction}
                          </span>
                        </label>
                      ))}
                      {!controllerLanes.length && <small>Add a lane to this site first.</small>}
                    </div>
                    <button
                      className="button primary"
                      disabled={busy || !controllerSiteId || !controllerLanes.length}
                    >
                      Create one-time enrollment code <Radio size={15} />
                    </button>
                  </form>
                )}
                {issuedControllerGrant && (
                  <div className="one-time-secret">
                    <strong>{issuedControllerGrant.name} · copy this code now</strong>
                    <code>{issuedControllerGrant.code}</code>
                    <small>
                      Expires {formatWhen(issuedControllerGrant.expiresAt)}. It will not be shown
                      again.
                    </small>
                  </div>
                )}
                {rotatedControllerCredential && (
                  <div className="one-time-secret">
                    <strong>
                      Updated credential · controller {rotatedControllerCredential.controllerId}
                    </strong>
                    <code>{rotatedControllerCredential.credential}</code>
                    <small>
                      Set SMARTGATE_CONTROLLER_CREDENTIAL on the edge once to replace its stored
                      credential.
                    </small>
                  </div>
                )}
                <div className="controller-list">
                  <h4>Enrolled controllers</h4>
                  {controllers.map((controller) => {
                    const siteName =
                      data?.sites.find((site) => site.id === controller.site_id)?.name ??
                      "Unknown site";
                    const laneNames = controller.lane_ids
                      .map((id) => data?.lanes.find((lane) => lane.id === id)?.name)
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <div className="controller-row" key={controller.id}>
                        <div className="controller-row-main">
                          <strong>{controller.name}</strong>
                          <small>
                            {siteName} · {laneNames || "No lanes"}
                          </small>
                          <small>
                            Last contact {formatWhen(controller.last_seen_at)} · config v
                            {controller.config_version} · {controller.pending_events} queued events
                          </small>
                        </div>
                        <Badge tone={controller.status === "active" ? "green" : "neutral"}>
                          {controller.status}
                        </Badge>
                        {canManageDevices && controller.status === "active" && (
                          <div className="controller-actions">
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => void rotateControllerCredential(controller)}
                            >
                              Renew credential
                            </button>
                            <button
                              className="text-button danger-text"
                              disabled={busy}
                              onClick={() => void revokeController(controller)}
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!controllers.length && <Empty text="No edge controllers are enrolled yet." />}
                </div>
                {canManageDevices && !!controllerGrants.length && (
                  <div className="controller-list">
                    <h4>Enrollment grants</h4>
                    {controllerGrants.map((grant) => {
                      const expired = new Date(grant.expires_at).getTime() <= Date.now();
                      const status = grant.revoked_at
                        ? "Revoked"
                        : grant.consumed_at
                          ? "Claimed"
                          : expired
                            ? "Expired"
                            : "Ready";
                      return (
                        <div className="controller-row" key={grant.id}>
                          <div className="controller-row-main">
                            <strong>{grant.name}</strong>
                            <small>
                              Expires {formatWhen(grant.expires_at)} · {grant.lane_ids.length}{" "}
                              assigned lane(s)
                            </small>
                          </div>
                          <Badge tone={status === "Ready" ? "amber" : "neutral"}>{status}</Badge>
                          {status === "Ready" && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => void revokeControllerGrant(grant)}
                            >
                              Revoke code
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
          {tab === "Gate station" && (
            <>
              <section className="stats">
                <Stat
                  icon={<DoorOpen />}
                  label="Operating mode"
                  value={local ? "Local" : "Unavailable"}
                  detail={
                    localLaneLabel ? "Assigned lanes · " + localLaneLabel : "Simulator · Main gate"
                  }
                />
                <Stat
                  icon={<Wifi />}
                  label="Cloud link"
                  value={local?.cloud_connected ? "Connected" : "Offline"}
                  detail={
                    local?.authorization_available === false
                      ? "Local authorization is paused; ask the HOA for help"
                      : local?.max_config_age_seconds
                        ? "Cached access limit: " +
                          Math.round(local.max_config_age_seconds / 3600) +
                          " hours"
                        : "Cached permissions stay local in demo mode"
                  }
                />
                <Stat
                  icon={<Radio />}
                  label="Configuration"
                  value={local ? "v" + local.config_version : "—"}
                  detail={
                    local?.authorization_available === false
                      ? "Cached policy expired or the controller clock is untrusted"
                      : "Last locally applied version"
                  }
                />
                <Stat
                  icon={<Activity />}
                  label="Queued events"
                  value={local?.pending_events ?? "—"}
                  detail="Stored before cloud upload"
                />
              </section>
              <div className="two-columns">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h3>Simulate a vehicle arrival</h3>
                      <p>Exercise local authorization without moving physical equipment.</p>
                    </div>
                    <Radio size={22} />
                  </div>
                  <form className="scan-form" onSubmit={scan}>
                    <label>
                      Credential format
                      <select value={scanFormat} onChange={(e) => setScanFormat(e.target.value)}>
                        <option value="epc">EPC / UHF</option>
                        <option value="wiegand26">Wiegand 26 payload</option>
                        <option value="wiegand34">Wiegand 34 payload</option>
                      </select>
                    </label>
                    <label>
                      Credential value
                      <input
                        value={scanValue}
                        onChange={(e) => setScanValue(e.target.value)}
                        required
                        maxLength={64}
                        className="mono"
                      />
                    </label>
                    <button className="button primary" disabled={busy || !local}>
                      <Radio size={17} />
                      {busy ? "Reading…" : "Present credential"}
                    </button>
                  </form>
                </section>
                <section className="panel result-panel">
                  {result ? (
                    <>
                      <span
                        className={"result-icon " + (result.decision === "granted" ? "" : "denied")}
                      >
                        {result.decision === "granted" ? <Check size={32} /> : <X size={32} />}
                      </span>
                      <h2>{result.decision === "granted" ? "Access granted" : "Access denied"}</h2>
                      <p>{result.vehicle_plate ?? "Unrecognized vehicle"}</p>
                      <Badge tone={result.decision === "granted" ? "green" : "amber"}>
                        {labels[result.reason] ?? result.reason}
                      </Badge>
                      <small>
                        {result.barrier_outcome === "simulated_open"
                          ? "Simulated opening recorded. Vehicle passage is unconfirmed."
                          : result.barrier_outcome === "cooldown"
                            ? "Opening suppressed while lane cooldown is active."
                            : "No barrier movement confirmed."}
                      </small>
                    </>
                  ) : (
                    <>
                      <span className="result-icon">
                        <CarFront size={32} />
                      </span>
                      <h3>Ready for the next arrival</h3>
                      <p>The local decision will appear here.</p>
                    </>
                  )}
                </section>
              </div>
              <EventTable events={events.slice(0, 8)} />
            </>
          )}
          {tab === "Help" && (
            <section className="panel help-panel">
              <ShieldCheck size={28} />
              <h2>{isGuard ? "Keep the entrance welcoming." : "Help with your access."}</h2>
              <p>
                {isGuard
                  ? "If a credential is denied, verify the resident or visitor using the village's agreed procedure. Use the commissioned operator's manual controls when authorized; this preview cannot move a real barrier."
                  : "If your tag is lost, report it from My vehicles and contact your village office for a replacement. If you arrive in another car, ask the guard for assistance."}
              </p>
              <p>
                During a network outage, previously synchronized permissions remain at the
                controller. Newly changed permissions take effect when the controller reconnects.
              </p>
              <p>
                Visitor invitations and emergency workflows are planned for subsequent
                implementation stages.
              </p>
            </section>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} /> Thoughtful access. Peace of mind.
            </span>
            <span>SmartGate · Local prototype</span>
          </footer>
        </div>
      </main>
      {enrolling && (
        <div
          className="modal-overlay"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEnrolling(false);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="enroll-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">WELCOME TO THE VILLAGE</p>
                <h2 id="enroll-title">Enroll a vehicle</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setEnrolling(false)}
                aria-label="Close enrollment"
              >
                <X />
              </button>
            </div>
            <form onSubmit={enroll} className="enrollment-form">
              <label>
                Household
                <select
                  name="property_id"
                  value={enrollmentPropertyId}
                  onChange={(event) => setEnrollmentPropertyId(event.target.value)}
                >
                  <option value="new">Create a new household</option>
                  {(data?.properties ?? [])
                    .filter((property) => property.occupancy_id)
                    .map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.label} · {property.resident_name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="form-grid">
                {enrollmentPropertyId === "new" && (
                  <>
                    <label>
                      Resident name
                      <input
                        autoFocus
                        name="resident"
                        required
                        maxLength={100}
                        placeholder="Full name"
                      />
                    </label>
                    <label>
                      Property / lot
                      <input
                        name="property"
                        required
                        maxLength={100}
                        placeholder="Lot 14 · Acacia Street"
                      />
                    </label>
                  </>
                )}
                <label>
                  Plate number
                  <input name="plate" required maxLength={20} placeholder="ABC 1234" />
                </label>
                <label>
                  Vehicle make / model
                  <input name="make" required maxLength={60} placeholder="Toyota Innova" />
                </label>
                <label>
                  Color
                  <input name="color" required maxLength={40} placeholder="Silver" />
                </label>
                <label>
                  Credential format
                  <select name="format">
                    <option value="epc">EPC / UHF</option>
                    <option value="wiegand26">Wiegand 26 payload</option>
                    <option value="wiegand34">Wiegand 34 payload</option>
                  </select>
                </label>
                <label className="full-width">
                  Credential value
                  <input
                    name="value"
                    required
                    maxLength={64}
                    pattern="[0-9a-fA-F]+"
                    placeholder="Scan or enter the hexadecimal identifier"
                    className="mono"
                  />
                </label>
              </div>
              {(data?.lanes ?? []).length > 0 && (
                <fieldset className="lane-picker">
                  <legend>Where this tag may be used</legend>
                  <p className="form-note">
                    Leave them all selected to authorize the tag at every gate in the village.
                  </p>
                  {(data?.lanes ?? []).map((lane) => (
                    <label key={lane.id} className="lane-option">
                      <input type="checkbox" name="lane_ids" value={lane.id} defaultChecked />
                      {lane.name}
                      <span className="muted">
                        {data?.sites.find((site) => site.id === lane.site_id)?.name ?? ""}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="form-note">
                {enrollmentPropertyId === "new"
                  ? "This creates a new household record. The controller must synchronize before the credential can grant access."
                  : "This vehicle will be added to the selected household. The controller must synchronize before the credential can grant access."}
              </p>
              {notice && (
                <div className="notice warning" role="alert">
                  {notice}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setEnrolling(false)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? "Saving…" : "Enroll vehicle"}
                  <ArrowUpRight size={16} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {statusChange && (
        <div
          className="modal-overlay"
          onKeyDown={(e) => {
            if (e.key === "Escape") setStatusChange(null);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="status-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CREDENTIAL UPDATE</p>
                <h2 id="status-title">
                  {statusChange.status === "lost"
                    ? statusChange.vehicle.credential_status === "lost"
                      ? "Request a replacement"
                      : "Report a lost tag"
                    : statusChange.status === "suspended"
                      ? "Suspend this credential?"
                      : "Reactivate this credential?"}
                </h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setStatusChange(null)}
                aria-label="Close confirmation"
              >
                <X />
              </button>
            </div>
            <div className="enrollment-form">
              <strong>{statusChange.vehicle.plate}</strong>
              <p className="form-note">
                {statusChange.status === "lost"
                  ? statusChange.vehicle.credential_status === "lost"
                    ? "The tag is already marked lost in the village system. Send a replacement request to your village office. "
                    : "The tag will be marked lost in the village system immediately. Your village office can issue a replacement. "
                  : ""}
                Disconnected gates apply this change when they reconnect. The gate acknowledgement
                appears in the request status.
              </p>
              <div className="modal-actions">
                <button
                  autoFocus
                  className="button secondary"
                  onClick={() => setStatusChange(null)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void changeStatus(statusChange.vehicle, statusChange.status)}
                >
                  {statusChange.status === "lost"
                    ? statusChange.vehicle.credential_status === "lost"
                      ? "Send replacement request"
                      : "Report lost and request replacement"
                    : "Confirm update"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {moveOutProperty && (
        <div
          className="modal-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape") setMoveOutProperty(null);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-out-title"
            onSubmit={(event) => void moveOut(event)}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">HOUSEHOLD ACCESS</p>
                <h2 id="move-out-title">Move-out for {moveOutProperty.label}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setMoveOutProperty(null)}
                aria-label="Close move-out confirmation"
              >
                <X />
              </button>
            </div>
            <div className="enrollment-form">
              <p className="form-note">
                Leave the date blank to end access now. A scheduled cutoff ends cloud access at the
                selected time and is enforced by a gate after that gate receives the schedule. Past
                access activity stays in the village record.
              </p>
              <label>
                Schedule cutoff (optional)
                <input
                  type="datetime-local"
                  name="effective_at"
                  value={moveOutEffectiveAt}
                  min={manilaDateTimeInput(new Date(Date.now() + 11 * 60_000).toISOString())}
                  onChange={(event) => setMoveOutEffectiveAt(event.target.value)}
                />
              </label>
              <small className="muted">
                Times are entered and shown in Asia/Manila (UTC+08:00).
              </small>
              <label>
                Reason (optional)
                <input
                  value={moveOutReason}
                  onChange={(event) => setMoveOutReason(event.target.value)}
                  maxLength={240}
                  placeholder="For example, household moved out"
                />
              </label>
              {notice && (
                <div className="notice warning" role="alert">
                  {notice}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  autoFocus
                  className="button secondary"
                  onClick={() => setMoveOutProperty(null)}
                >
                  Cancel
                </button>
                <button className="button destructive" disabled={busy}>
                  {busy ? "Saving…" : moveOutEffectiveAt ? "Schedule move-out" : "End access now"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      {retirementVehicle && (
        <div
          className="modal-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape") setRetirementVehicle(null);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vehicle-retirement-title"
            onSubmit={(event) => void retireVehicle(event)}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">VEHICLE ACCESS</p>
                <h2 id="vehicle-retirement-title">
                  {isResident ? "Report vehicle sold or removed" : "Remove this vehicle?"}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setRetirementVehicle(null)}
                aria-label="Close vehicle removal"
              >
                <X />
              </button>
            </div>
            <div className="enrollment-form">
              <p className="form-note">
                {retirementVehicle.plate} · {retirementVehicle.make}. Removing this vehicle ends its
                tag access and keeps its history. Other vehicles and people at the home stay active.
                {isResident
                  ? " The village office reviews your request before access is removed."
                  : ""}
              </p>
              <label>
                Reason (optional)
                <input
                  name="reason"
                  value={retirementReason}
                  onChange={(event) => setRetirementReason(event.target.value)}
                  maxLength={240}
                  placeholder="For example, sold to a new owner"
                />
              </label>
              {notice && (
                <div className="notice warning" role="alert">
                  {notice}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setRetirementVehicle(null)}
                >
                  Cancel
                </button>
                <button className="button destructive" disabled={busy}>
                  {busy ? "Saving…" : isResident ? "Send request" : "Remove vehicle access"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      {correctionVehicle && (
        <div
          className="modal-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape") setCorrectionVehicle(null);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vehicle-correction-title"
            onSubmit={(event) => void requestVehicleCorrection(event)}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">VEHICLE DETAILS</p>
                <h2 id="vehicle-correction-title">Request a correction</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setCorrectionVehicle(null)}
                aria-label="Close correction request"
              >
                <X size={18} />
              </button>
            </div>
            <div className="enrollment-form">
              <p className="form-note">
                Your village office reviews changes before they appear at the gate.
              </p>
              <label>
                Plate
                <input
                  name="plate"
                  defaultValue={correctionVehicle.plate}
                  maxLength={20}
                  required
                />
              </label>
              <label>
                Make / model
                <input name="make" defaultValue={correctionVehicle.make} maxLength={60} required />
              </label>
              <label>
                Color
                <input
                  name="color"
                  defaultValue={correctionVehicle.color}
                  maxLength={40}
                  required
                />
              </label>
              {notice && (
                <div className="notice warning" role="alert">
                  {notice}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setCorrectionVehicle(null)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? "Sending…" : "Send request"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      {vehicleDecision && (
        <div
          className="modal-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape") setVehicleDecision(null);
          }}
        >
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vehicle-decision-title"
            onSubmit={(event) => void decideVehicleChange(event)}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">VILLAGE REVIEW</p>
                <h2 id="vehicle-decision-title">
                  {vehicleDecision.action === "approve" ? "Approve" : "Decline"} vehicle correction?
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setVehicleDecision(null)}
                aria-label="Close vehicle decision"
              >
                <X size={18} />
              </button>
            </div>
            <div className="enrollment-form">
              <p>
                Current: {vehicleDecision.request.prior_plate} ·{" "}
                {vehicleDecision.request.prior_make} · {vehicleDecision.request.prior_color}
              </p>
              <p>
                Requested: {vehicleDecision.request.proposed_plate} ·{" "}
                {vehicleDecision.request.proposed_make} · {vehicleDecision.request.proposed_color}
              </p>
              <label>
                Decision note {vehicleDecision.action === "reject" ? "(required)" : "(optional)"}
                <input
                  name="decision_note"
                  maxLength={240}
                  required={vehicleDecision.action === "reject"}
                />
              </label>
              {notice && (
                <div className="notice warning" role="alert">
                  {notice}
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setVehicleDecision(null)}
                >
                  Cancel
                </button>
                <button
                  className={
                    vehicleDecision.action === "approve" ? "button primary" : "button destructive"
                  }
                  disabled={busy}
                >
                  {busy
                    ? "Saving…"
                    : vehicleDecision.action === "approve"
                      ? "Approve change"
                      : "Decline request"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      {inviting && (
        <div
          className="modal-overlay"
          onKeyDown={(e) => {
            if (e.key === "Escape") setInviting(false);
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">ADD SOMEONE</p>
                <h2 id="invite-title">Invite to {data?.organization.name ?? "this village"}</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setInviting(false)}
                aria-label="Close invitation"
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={inviteStaff} className="enrollment-form">
              <div className="form-grid">
                <label>
                  Email
                  <input
                    autoFocus
                    name="email"
                    type="email"
                    required
                    placeholder="person@example.com"
                  />
                </label>
                <label>
                  Role
                  <select
                    name="role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value)}
                  >
                    <option value="hoa_admin">Village administrator</option>
                    <option value="guard">Security guard</option>
                    <option value="resident">Resident</option>
                  </select>
                </label>
                {inviteRole === "guard" && (
                  <label className="full-width">
                    Assigned station
                    <select name="site_id" required>
                      {(data?.sites ?? []).map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {inviteRole === "resident" && (
                  <label className="full-width">
                    Household
                    <select
                      name="property_id"
                      required
                      value={invitePropertyId || data?.properties[0]?.id || ""}
                      onChange={(event) => setInvitePropertyId(event.target.value)}
                    >
                      {(data?.properties ?? []).map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.label} · {property.resident_name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {inviteRole === "resident" && (
                  <label className="full-width">
                    Relationship
                    <select name="relationship" defaultValue="">
                      <option value="">Choose automatically</option>
                      <option value="owner">Owner</option>
                      <option value="tenant">Tenant</option>
                      <option value="family_member">Family member</option>
                      <option value="occupant">Occupant</option>
                    </select>
                  </label>
                )}
              </div>
              <p className="form-note">
                {inviteRole === "guard"
                  ? "A guard sees the vehicles and activity for the assigned station, and cannot administer the village."
                  : inviteRole === "resident"
                    ? "A resident sees only the household selected here, including its current vehicles and access history. Accepting an invitation starts a new occupancy when the home is vacant."
                    : "A village administrator can enroll vehicles, manage credentials, and invite members."}
              </p>
              {!data?.properties.length && inviteRole === "resident" && (
                <div className="notice warning" role="status">
                  Enroll a vehicle first. Households come from enrollment in this release.
                </div>
              )}
              <div className="modal-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setInviting(false)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? "Creating…" : "Create invitation"}
                  <UserPlus size={16} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="search-box">
      <Search size={16} />
      <input
        aria-label="Search vehicles or residents"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search…"
      />
    </label>
  );
}
function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        <span>{icon}</span>
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}
function Device({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Activity size={22} />
      <p>{text}</p>
    </div>
  );
}
function EventTable({ events, onAll }: { events: Event[]; onAll?: () => void }) {
  return (
    <section className="panel events-panel">
      <div className="panel-heading">
        <div>
          <h3>Access activity</h3>
          <p>Authorization records. Passage is only confirmed when independently detected.</p>
        </div>
        {onAll && (
          <button className="text-button" onClick={onAll}>
            View activity
            <ChevronRight size={15} />
          </button>
        )}
      </div>
      {events.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Vehicle / credential</th>
                <th>Time</th>
                <th>Decision</th>
                <th>Reason</th>
                <th>Barrier result</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id}>
                  <td>
                    <strong className="event-vehicle">
                      <ArrowDownLeft size={15} />
                      {e.vehicle_plate ?? "Unknown vehicle"}
                    </strong>
                    <small className="mono">{e.value}</small>
                  </td>
                  <td>
                    {formatTime(e.observed_at)}
                    <small>
                      {new Date(e.observed_at).toLocaleDateString("en-PH", {
                        month: "short",
                        day: "numeric",
                      })}
                      {e.offline ? " · Offline" : ""}
                    </small>
                  </td>
                  <td>
                    <Badge tone={e.decision === "granted" ? "green" : "amber"}>
                      {e.decision === "granted" ? "Granted" : "Denied"}
                    </Badge>
                  </td>
                  <td>{labels[e.reason] ?? e.reason}</td>
                  <td>
                    {e.barrier_outcome === "simulated_open"
                      ? "Simulated opening"
                      : e.barrier_outcome === "cooldown"
                        ? "Cooldown"
                        : e.barrier_outcome === "fault"
                          ? "Unconfirmed / fault"
                          : "No opening requested"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty text="No access attempts yet. New records will appear after synchronization." />
      )}
    </section>
  );
}
