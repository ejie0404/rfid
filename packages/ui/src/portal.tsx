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
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

type Mode = "control" | "guard" | "resident";
type Vehicle = {
  id: string;
  plate: string;
  make: string;
  color: string;
  property_label: string;
  resident_name: string;
  credential_id: string;
  credential_value: string;
  format: string;
  credential_status: string;
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
};
type Local = {
  config_version: number;
  cloud_connected: boolean;
  pending_events: number;
  hardware: string;
  events: Event[];
};
const API = "http://127.0.0.1:4100";
const EDGE = "http://127.0.0.1:4200";
const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
const labels: Record<string, string> = {
  VALID_CREDENTIAL: "Registered credential",
  UNKNOWN_CREDENTIAL: "Unrecognized credential",
  CREDENTIAL_INACTIVE: "Credential is inactive",
  GATE_NOT_ALLOWED: "Lane access unavailable",
  OUTSIDE_VALIDITY: "Outside validity period",
  NO_CONFIGURATION: "Awaiting configuration",
  CLOCK_UNTRUSTED: "Controller clock needs attention",
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
  const nav = isGuard
    ? ["Gate station", "Access activity", "Help"]
    : isResident
      ? ["My home", "My vehicles", "My activity", "Help"]
      : ["Overview", "Residents", "Vehicles & RFID", "Access activity", "Gates & devices"];
  const [tab, setTab] = useState(nav[0]!);
  const [data, setData] = useState<Snapshot | null>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [statusChange, setStatusChange] = useState<{ vehicle: Vehicle; status: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [scanValue, setScanValue] = useState("E2000017221101441890ABCD");
  const [scanFormat, setScanFormat] = useState("epc");
  const [result, setResult] = useState<Event | null>(null);
  const token = useRef("");
  const active = useRef(true);
  const loading = useRef(false);
  const profile = isGuard ? "guard" : isResident ? "resident" : "admin";
  const request = useCallback(
    async (path: string, body?: unknown) => {
      if (!token.current) {
        const response = await fetch(API + "/demo/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile }),
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error("Could not start the local demonstration session.");
        token.current = (await response.json()).token;
      }
      const response = await fetch(API + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.current },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 401) token.current = "";
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : "The request could not be completed.",
        );
      return payload;
    },
    [profile],
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
  useEffect(() => {
    active.current = true;
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => {
      active.current = false;
      clearInterval(id);
    };
  }, [load]);
  const vehicles = (data?.vehicles ?? []).filter((v) =>
    [v.plate, v.make, v.resident_name, v.property_label]
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const events = (isGuard ? (local?.events ?? data?.events) : data?.events) ?? [];
  const heartbeat = data?.heartbeats[0];
  const fresh = !!heartbeat && Date.now() - new Date(heartbeat.received_at).getTime() < 20000;
  const synced = fresh && heartbeat?.payload.config_version === data?.organization.config_version;
  const pending = isGuard ? local?.pending_events : heartbeat?.payload.pending_events;
  const residents = [...new Map(vehicles.map((v) => [v.property_label, v])).values()];
  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    const form = new FormData(event.currentTarget);
    try {
      await request("/enrollments", Object.fromEntries(form.entries()));
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
  const icon = (name: string) =>
    name.includes("vehicle") || name.includes("Vehicles") ? (
      <CarFront size={18} />
    ) : name.includes("Residents") ? (
      <Users size={18} />
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
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <div className="workspace">
          <span className="workspace-icon">
            <Building2 size={19} />
          </span>
          <div>
            <strong>{data?.organization.name ?? "Palm Grove Village"}</strong>
            <small>
              {isGuard
                ? "Main gate · Entry lane"
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
            <span className="avatar">{isResident ? "AS" : isGuard ? "MG" : "VA"}</span>
            <div>
              <strong>{data?.principal.name ?? "Local demonstration"}</strong>
              <small>{isResident ? "Resident" : isGuard ? "Guard station" : "Administrator"}</small>
            </div>
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
        <div className="demo-banner">
          <span>DEVELOPMENT PREVIEW</span> Sample village · local demo sessions · simulated barrier
        </div>
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
              <button className="button primary" onClick={() => setEnrolling(true)}>
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
                          {["active", "suspended"].includes(v.credential_status) ? (
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
          {showEvents && <EventTable events={events} />}
          {tab === "Gates & devices" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h3>Main gate · Entry</h3>
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
                    fresh ? "Version " + heartbeat?.payload.config_version : "Not received recently"
                  }
                />
                <Device label="Events awaiting upload" value={pending ?? "Unknown"} />
                <Device label="Current hardware mode" value="Simulator" />
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
          )}
          {tab === "Gate station" && (
            <>
              <section className="stats">
                <Stat
                  icon={<DoorOpen />}
                  label="Operating mode"
                  value={local ? "Local" : "Unavailable"}
                  detail="Simulator · Main gate"
                />
                <Stat
                  icon={<Wifi />}
                  label="Cloud link"
                  value={local?.cloud_connected ? "Connected" : "Offline"}
                  detail="Cached permissions stay local"
                />
                <Stat
                  icon={<Radio />}
                  label="Configuration"
                  value={local ? "v" + local.config_version : "—"}
                  detail="Last locally applied version"
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
              <div className="form-grid">
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
              <p className="form-note">
                This creates a property record for the new enrollment. The controller must
                synchronize before the credential can grant access.
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
