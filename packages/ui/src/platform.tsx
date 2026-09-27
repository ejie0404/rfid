"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, Copy, DoorOpen, LogOut, Plus, RefreshCw, UserPlus, X } from "lucide-react";
import type { Auth, Session } from "./auth";
import { MFA_SETUP_REQUIRED, SecurityPanel } from "./security";

type Village = {
  id: string;
  name: string;
  config_version: number;
  members: number;
  properties: number;
};
type IssuedInvitation = {
  villageName: string;
  email: string;
  token: string;
  link: string;
  expiresInDays: number;
};

// A non-breaking space keeps a count and its unit on one line ("7 days", "1 member").
const plural = (count: number, one: string, many: string) =>
  `${count}\u00a0${count === 1 ? one : many}`;
const byName = (left: Village, right: Village) => left.name.localeCompare(right.name);

/**
 * The management app's home for a platform account that is not working inside a village. A
 * platform administrator adds customer villages and issues each one's first administrator
 * invitation; platform support can only review the list. Customer households and vehicles stay
 * behind memberships and audited support grants, so this screen never reads them.
 */
export function PlatformConsole({
  api,
  auth,
  session,
}: {
  api: string;
  auth: Auth;
  session: Session;
}) {
  const canManage = session.platform_role === "platform_admin";
  const [villages, setVillages] = useState<Village[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"" | "village" | "invite">("");
  const [villageName, setVillageName] = useState("");
  const [inviteFor, setInviteFor] = useState<Village | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const issuedHeading = useRef<HTMLHeadingElement>(null);
  const { token, onUnauthorized, requireMfaSetup } = auth;

  const request = useCallback(
    async (path: string, body?: unknown) => {
      const response = await fetch(api + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.current },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) {
        onUnauthorized();
        throw new Error("Your session has ended. Sign in again.");
      }
      if (response.status === 403 && payload.code === MFA_SETUP_REQUIRED) {
        requireMfaSetup();
        throw new Error("Set up two-step verification before using this account.");
      }
      if (!response.ok)
        throw new Error(
          typeof payload.message === "string"
            ? payload.message
            : "The request could not be completed.",
        );
      return payload;
    },
    [api, token, onUnauthorized, requireMfaSetup],
  );

  const load = useCallback(async () => {
    setLoadError("");
    try {
      setVillages(((await request("/platform/organizations")) as Village[]).sort(byName));
    } catch (issue) {
      setLoadError((issue as Error).message);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  // Move focus to a newly issued invitation so keyboard and screen reader users land on it.
  useEffect(() => {
    if (issued) issuedHeading.current?.focus();
  }, [issued]);

  function startInvite(village: Village) {
    setIssued(null);
    setError("");
    setInviteEmail("");
    setInviteFor(village);
  }

  async function addVillage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("village");
    setError("");
    setNotice("");
    try {
      const created = (await request("/platform/organizations", { name: villageName })) as Village;
      setVillageName("");
      setVillages((current) =>
        [...(current ?? []).filter((row) => row.id !== created.id), created].sort(byName),
      );
      setNotice(`${created.name} was added. Invite its first administrator next.`);
      startInvite(created);
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteFor) return;
    setBusy("invite");
    setError("");
    setNotice("");
    try {
      const created = await request("/invitations", {
        email: inviteEmail,
        role: "hoa_admin",
        organization_id: inviteFor.id,
      });
      // The management app accepts `?invite=` links, so the administrator can open this directly.
      const link = new URL(window.location.pathname, window.location.origin);
      link.searchParams.set("invite", created.token);
      setIssued({
        villageName: inviteFor.name,
        email: created.email,
        token: created.token,
        link: link.toString(),
        expiresInDays: Number(created.expires_in_days) || 7,
      });
      setInviteFor(null);
      setInviteEmail("");
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setError("");
      setNotice(`${label} copied.`);
    } catch {
      setError(`Copying is not available here. Select the ${label.toLowerCase()} and copy it.`);
    }
  }

  const problem = error || auth.error;
  return (
    <div className="platform-shell">
      <div className="platform-page">
        <header className="platform-header">
          <div className="brand">
            <span className="brand-mark">
              <DoorOpen size={22} />
            </span>
            <span>
              smartgate<span className="brand-dot">.</span>
            </span>
          </div>
          <div className="platform-account">
            <span>
              <strong>{session.principal.name}</strong>
              <small>
                {session.principal.email} ·{" "}
                {canManage ? "Platform administrator" : "Platform support"}
              </small>
            </span>
            <button className="button secondary" onClick={() => void auth.logout()}>
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </header>
        <main className="platform-main">
          <div>
            <p className="eyebrow">SMARTGATE OPERATIONS</p>
            <h1>Villages</h1>
            <p className="subtitle">
              {canManage
                ? "Add a customer village, then invite its first administrator. That administrator invites guards and residents from Staff & access."
                : "Support accounts can review the customer list. A platform administrator adds villages and sends first-administrator invitations."}
            </p>
          </div>
          <div className="platform-live" role="status" aria-live="polite">
            {notice && <div className="notice">{notice}</div>}
          </div>
          {problem && (
            <div className="notice warning" role="alert">
              {problem}
            </div>
          )}
          {!session.mfa_enabled && (
            <div className="notice warning" role="status">
              Turn on two-step verification before managing customer villages. Platform accounts can
              reach every customer.
            </div>
          )}
          {issued && (
            <section className="panel invite-issued" aria-labelledby="issued-invitation-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">INVITATION READY</p>
                  <h2 id="issued-invitation-title" ref={issuedHeading} tabIndex={-1}>
                    Deliver this to {issued.email}
                  </h2>
                  <p>
                    An administrator invitation for {issued.villageName}. Outbound email is not
                    configured yet, so the invitation is shown once here. It works for one sign-up
                    and expires in {plural(issued.expiresInDays, "day", "days")}.
                  </p>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setIssued(null)}
                  aria-label="Dismiss invitation"
                >
                  <X size={16} />
                </button>
              </div>
              <dl className="invite-values">
                <dt>Invitation link</dt>
                <dd className="mono invite-token">{issued.link}</dd>
                <dt>Invitation code</dt>
                <dd className="mono invite-token">{issued.token}</dd>
              </dl>
              <div className="invite-actions">
                <button
                  className="button secondary"
                  onClick={() => void copy(issued.link, "Invitation link")}
                >
                  <Copy size={16} />
                  Copy link
                </button>
                <button
                  className="button secondary"
                  onClick={() => void copy(issued.token, "Invitation code")}
                >
                  <Copy size={16} />
                  Copy code
                </button>
              </div>
            </section>
          )}
          {canManage && inviteFor && (
            <section key={inviteFor.id} className="panel" aria-labelledby="invite-admin-title">
              <div className="panel-heading">
                <div>
                  <h2 id="invite-admin-title">Invite an administrator for {inviteFor.name}</h2>
                  <p>They will manage staff, residents, and gate access for this village.</p>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setInviteFor(null)}
                  aria-label="Cancel invitation"
                >
                  <X size={16} />
                </button>
              </div>
              <form className="village-form" onSubmit={invite}>
                <label>
                  Administrator email
                  <input
                    type="email"
                    required
                    maxLength={160}
                    autoFocus
                    autoComplete="off"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="admin@example.com"
                  />
                </label>
                <button className="button primary" disabled={!!busy}>
                  <UserPlus size={16} />
                  {busy === "invite" ? "Creating…" : "Create invitation"}
                </button>
              </form>
            </section>
          )}
          {canManage && (
            <section className="panel" aria-labelledby="add-village-title">
              <div className="panel-heading">
                <div>
                  <h2 id="add-village-title">Add a village</h2>
                  <p>Use the name its residents and staff will recognize. Each name is unique.</p>
                </div>
              </div>
              <form className="village-form" onSubmit={addVillage}>
                <label>
                  Village name
                  <input
                    required
                    maxLength={100}
                    autoComplete="off"
                    value={villageName}
                    onChange={(event) => setVillageName(event.target.value)}
                    placeholder="Palm Grove Village"
                  />
                </label>
                <button className="button primary" disabled={!!busy}>
                  <Plus size={16} />
                  {busy === "village" ? "Adding…" : "Add village"}
                </button>
              </form>
            </section>
          )}
          <section
            className="panel"
            aria-labelledby="villages-title"
            aria-busy={villages === null && !loadError}
          >
            <div className="panel-heading">
              <div>
                <h2 id="villages-title">Customer villages</h2>
                <p>
                  {villages
                    ? plural(villages.length, "village", "villages")
                    : loadError
                      ? "The list could not be loaded."
                      : "Loading villages…"}
                </p>
              </div>
              <button className="button secondary" onClick={() => void load()}>
                <RefreshCw size={16} />
                Refresh
              </button>
            </div>
            {loadError && (
              <div className="notice warning village-list-notice" role="alert">
                {loadError}
              </div>
            )}
            {villages && villages.length === 0 && (
              <div className="empty">
                <Building2 size={28} />
                <p>
                  {canManage ? "No villages yet. Add the first one above." : "No villages yet."}
                </p>
              </div>
            )}
            {villages && villages.length > 0 && (
              <ul className="village-list">
                {villages.map((village) => (
                  <li key={village.id} className="village-row">
                    <div className="village-row-main">
                      <strong>{village.name}</strong>
                      <small>
                        {plural(village.members, "member", "members")} ·{" "}
                        {plural(village.properties, "home", "homes")}
                      </small>
                    </div>
                    {village.members === 0 && (
                      <span className="badge amber">Awaiting administrator</span>
                    )}
                    {canManage && (
                      <button
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => startInvite(village)}
                        aria-label={`Invite administrator for ${village.name}`}
                      >
                        <UserPlus size={16} />
                        Invite administrator
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {session.memberships.length > 0 && (
            <section className="panel" aria-labelledby="memberships-title">
              <div className="panel-heading">
                <div>
                  <h2 id="memberships-title">Your village memberships</h2>
                  <p>Open a village where this account is a member.</p>
                </div>
              </div>
              <ul className="village-list">
                {session.memberships.map((membership) => (
                  <li key={membership.membershipId} className="village-row">
                    <div className="village-row-main">
                      <strong>{membership.organizationName}</strong>
                      <small>{membership.role.replace("_", " ")}</small>
                    </div>
                    <button
                      className="button secondary"
                      disabled={auth.busy}
                      onClick={() => void auth.selectOrganization(membership.organizationId)}
                      aria-label={`Open ${membership.organizationName}`}
                    >
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <SecurityPanel api={api} auth={auth} />
        </main>
      </div>
    </div>
  );
}
