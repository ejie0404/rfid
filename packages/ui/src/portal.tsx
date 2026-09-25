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
type Snapshot = {
  organization: { name: string; config_version: number };
  principal: { name: string };
  vehicles: Vehicle[];
  events: Event[];
  heartbeats: {
    payload: { config_version: number; pending_events: number };
    received_at: string;
  }[];
  properties: { id: string; label: string; resident_name: string }[];
  sites: { id: string; name: string; code: string }[];
  lanes: { id: string; name: string; site_id: string; direction: string }[];
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  site_id: string | null;
  property_id: string | null;
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
    ? new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
    : "No contact yet";
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

export function Portal({ mode }: { mode: Mode }) {
  const isGuard = mode === "guard",
    isResident = mode === "resident";
  const auth = useSession(API);
  const { session, token, onUnauthorized, logout, demoEnabled } = auth;
  const canManageDevices =
    session?.principal.role === "hoa_admin" || session?.principal.role === "platform_admin";
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
  const [issuedInvite, setIssuedInvite] = useState<{
    email: string;
    role: string;
    token: string;
  } | null>(null);
  const active = useRef(true);
  const loading = useRef(false);
  const request = useCallback(
    async (path: string, body?: unknown) => {
      const response = await fetch(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.current },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        onUnauthorized();
        throw new Error("Your session has ended. Sign in again.");
      }
      if (!response.ok)
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : "The request could not be completed.",
        );
      return payload;
    },
    [onUnauthorized, token],
  );
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
        setData(cloud.value);
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
  const residents = [...new Map(vehicles.map((v) => [v.property_label, v])).values()];
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
      await request("/credentials/" + v.credential_id + "/status", { status });
      setNotice("Credential updated. Delivery to the gate is tracked separately.");
      await load();
    } catch (e) {
      setNotice((e as Error).message);
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
    if (role === "resident") body.property_id = String(form.get("property_id") ?? "");
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
              <EventTable
                events={events.slice(0, 5)}
                onAll={() => setTab(isResident ? "My activity" : "Access activity")}
              />
            </>
          )}
          {showVehicles && (
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
                    {vehicles.map((v) => (
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
                          {["active", "suspended"].includes(v.credential_status ?? "") ? (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                setStatusChange({
                                  vehicle: v,
                                  status: isResident
                                    ? "lost"
                                    : v.credential_status === "active"
                                      ? "suspended"
                                      : "active",
                                })
                              }
                            >
                              {isResident
                                ? "Report lost"
                                : v.credential_status === "active"
                                  ? "Suspend"
                                  : "Reactivate"}
                            </button>
                          ) : (
                            <span className="muted">Replacement required</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!vehicles.length && <Empty text="No matching vehicles." />}
            </section>
          )}
          {tab === "Residents" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Homes in your village</h3>
                  <p>Property and resident records for the current village.</p>
                </div>
                <SearchBox value={search} onChange={setSearch} />
              </div>
              {residents.map((v) => (
                <div className="resident-row" key={v.property_label}>
                  <span className="avatar">
                    <Home size={18} />
                  </span>
                  <div>
                    <strong>{v.resident_name}</strong>
                    <p>{v.property_label}</p>
                  </div>
                  <Badge>
                    {vehicles.filter((x) => x.property_label === v.property_label).length}{" "}
                    vehicle(s)
                  </Badge>
                </div>
              ))}
              {!residents.length && <Empty text="Enroll a vehicle and resident to begin." />}
            </section>
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
                  {(data?.properties ?? []).map((property) => (
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
                    ? "Report a lost tag"
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
                {statusChange.status === "lost" ? "A lost tag will require replacement. " : ""}
                Disconnected gates apply this change when they reconnect. The gate acknowledgement
                appears separately from the cloud status.
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
                  Confirm update
                </button>
              </div>
            </div>
          </section>
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
                    <select name="property_id" required>
                      {(data?.properties ?? []).map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.label} · {property.resident_name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="form-note">
                {inviteRole === "guard"
                  ? "A guard sees the vehicles and activity for the assigned station, and cannot administer the village."
                  : inviteRole === "resident"
                    ? "A resident sees only the household selected here, including its vehicles and access history."
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
