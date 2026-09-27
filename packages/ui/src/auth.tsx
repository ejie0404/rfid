"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Building2, Check, DoorOpen, KeyRound, LogOut, ShieldCheck, Users } from "lucide-react";

export type Mode = "control" | "guard" | "resident";
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationId: string | null;
  membershipId: string | null;
  properties: string[];
  sites: string[];
  supportGrantId?: string;
  sessionId: string;
}
export interface MembershipSummary {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  role: string;
  status: string;
}
export interface Session {
  token: string;
  principal: Principal;
  memberships: MembershipSummary[];
  platform_role?: string;
  mfa_enabled: boolean;
  /** A privileged account must finish MFA enrollment before this session can do anything else. */
  mfa_setup_required?: boolean;
}
/** The demonstration sign-in is offered only when the API reports that it is enabled. */
const demoProfiles: Record<Mode, { profile: string; label: string }[]> = {
  control: [
    { profile: "admin", label: "Village administrator" },
    { profile: "other", label: "Second village administrator" },
    { profile: "platform", label: "SmartGate operator" },
  ],
  guard: [{ profile: "guard", label: "Main gate guard" }],
  resident: [{ profile: "resident", label: "Resident · Lot 12" }],
};
export function useSession(api: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const [operatorConfigured, setOperatorConfigured] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState("");
  const [pendingInvitation, setPendingInvitation] = useState("");
  const token = useRef("");
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get("invite");
    if (invite) setPendingInvitation(invite);
  }, []);
  useEffect(() => {
    if (!api) return;
    let active = true;
    fetch(api + "/setup/status", { signal: AbortSignal.timeout(3000) })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active || !payload) return;
        setDemoEnabled(!!payload.demo);
        setOperatorConfigured(!!payload.operator_configured);
      })
      .catch(() => {
        if (active) setError("The management service is not responding.");
      });
    return () => {
      active = false;
    };
  }, [api]);
  const adopt = useCallback((payload: Session) => {
    token.current = payload.token;
    setSession(payload);
    setChallenge("");
    setError("");
  }, []);
  const post = useCallback(
    async (path: string, body: unknown) => {
      const response = await fetch(api + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          typeof payload.message === "string" ? payload.message : "The request failed.",
        );
      return payload;
    },
    [api],
  );
  const login = useCallback(
    async (email: string, password: string) => {
      setBusy(true);
      setError("");
      try {
        const payload = await post("/auth/login", { email, password });
        if (payload.mfa_required) setChallenge(payload.challenge);
        else adopt(payload as Session);
      } catch (issue) {
        setError((issue as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [adopt, post],
  );
  const verifyMfa = useCallback(
    async (code: string) => {
      setBusy(true);
      setError("");
      try {
        adopt((await post("/auth/mfa/verify", { challenge, code })) as Session);
      } catch (issue) {
        setError((issue as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [adopt, challenge, post],
  );
  const useDemo = useCallback(
    async (profile: string) => {
      setBusy(true);
      setError("");
      try {
        adopt((await post("/demo/session", { profile })) as Session);
      } catch (issue) {
        setError((issue as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [adopt, post],
  );
  const cancelMfa = useCallback(() => {
    setChallenge("");
    setError("");
  }, []);
  /**
   * Accepts an invitation. An account that already exists must be signed in first, because a token
   * on its own must never issue a session as somebody else; the server enforces that too.
   */
  const acceptInvitation = useCallback(
    async (inviteToken: string, name?: string, password?: string) => {
      setBusy(true);
      setError("");
      setPendingInvitation(inviteToken.trim());
      try {
        const response = await fetch(api + "/auth/invitations/accept", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token.current ? { Authorization: "Bearer " + token.current } : {}),
          },
          body: JSON.stringify({
            token: inviteToken,
            ...(name ? { name } : {}),
            ...(password ? { password } : {}),
          }),
          signal: AbortSignal.timeout(8000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(payload.message ?? "The invitation could not be accepted.");
        adopt(payload as Session);
        setPendingInvitation("");
        const url = new URL(window.location.href);
        if (url.searchParams.has("invite")) {
          url.searchParams.delete("invite");
          window.history.replaceState({}, "", url);
        }
        return true;
      } catch (issue) {
        setError((issue as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [adopt, api],
  );
  const clearPendingInvitation = useCallback(() => {
    setPendingInvitation("");
    const url = new URL(window.location.href);
    if (url.searchParams.has("invite")) {
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url);
    }
  }, []);
  /** Chooses which organization the session acts in. Only memberships are offered. */
  const selectOrganization = useCallback(
    async (organizationId: string) => {
      setBusy(true);
      setError("");
      try {
        const response = await fetch(api + "/auth/scope", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token.current,
          },
          body: JSON.stringify({ organization_id: organizationId }),
          signal: AbortSignal.timeout(8000),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message ?? "That organization is not available.");
        adopt(payload as Session);
      } catch (issue) {
        setError((issue as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [adopt, api],
  );
  const logout = useCallback(async () => {
    try {
      await fetch(api + "/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + token.current },
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // The session is discarded locally even if the server could not be reached.
    }
    token.current = "";
    setSession(null);
    setNotice("");
    setError("");
  }, [api]);
  /** Called by any request that is refused, so the app returns to the sign-in screen. */
  const onUnauthorized = useCallback((message?: string) => {
    token.current = "";
    setSession(null);
    setChallenge("");
    setError(message ?? "Your session has ended. Sign in again.");
  }, []);
  /** Records that this account now requires MFA; the current session already satisfied it. */
  const markMfaEnabled = useCallback(() => {
    setSession((current) => (current ? { ...current, mfa_enabled: true } : current));
  }, []);
  /** Called when the API reports that this session is limited to MFA enrollment. */
  const requireMfaSetup = useCallback(() => {
    setSession((current) => (current ? { ...current, mfa_setup_required: true } : current));
  }, []);
  /** Leaves the required-setup screen once the recovery codes have been saved. */
  const completeMfaSetup = useCallback(() => {
    setSession((current) => (current ? { ...current, mfa_setup_required: false } : current));
  }, []);
  return {
    session,
    token,
    demoEnabled,
    operatorConfigured,
    error,
    notice,
    busy,
    challenge,
    pendingInvitation,
    setPendingInvitation,
    setNotice,
    setError,
    clearPendingInvitation,
    login,
    verifyMfa,
    cancelMfa,
    useDemo,
    acceptInvitation,
    selectOrganization,
    logout,
    onUnauthorized,
    markMfaEnabled,
    requireMfaSetup,
    completeMfaSetup,
  };
}
export type Auth = ReturnType<typeof useSession>;
const copy: Record<Mode, { title: string; subtitle: string; eyebrow: string }> = {
  control: {
    eyebrow: "VILLAGE MANAGEMENT",
    title: "Sign in to your village.",
    subtitle: "Enrollment, residents, and access for the community you manage.",
  },
  guard: {
    eyebrow: "GUARD STATION",
    title: "Start your shift.",
    subtitle: "The entrance, the lane, and everyone arriving today.",
  },
  resident: {
    eyebrow: "RESIDENT PORTAL",
    title: "Welcome home.",
    subtitle: "Your vehicles, your tag, and your household's access.",
  },
};
export function LoginScreen({ mode, auth }: { mode: Mode; auth: Auth }) {
  const [mfaCode, setMfaCode] = useState("");
  const [view, setView] = useState<"signin" | "invite">("signin");
  const words = copy[mode];
  useEffect(() => {
    if (auth.pendingInvitation) setView("invite");
  }, [auth.pendingInvitation]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await auth.login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  }
  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await auth.verifyMfa(mfaCode);
  }
  return (
    <div className="login-shell">
      <section className="login-card">
        <div className="brand">
          <span className="brand-mark">
            <DoorOpen size={22} />
          </span>
          <span>
            smartgate<span className="brand-dot">.</span>
          </span>
        </div>
        <p className="eyebrow">{view === "invite" ? "YOU HAVE BEEN INVITED" : words.eyebrow}</p>
        <h1>
          {auth.challenge
            ? "Enter your verification code"
            : view === "invite"
              ? "Join your village."
              : words.title}
        </h1>
        <p className="subtitle">
          {auth.challenge
            ? "Open your authenticator app and enter the six-digit code for SmartGate."
            : view === "invite"
              ? "Enter the invitation code you were sent. If you already have an account, sign in first and then accept it."
              : words.subtitle}
        </p>
        {auth.error && (
          <div className="notice warning" role="alert">
            {auth.error}
          </div>
        )}
        {view === "invite" && !auth.challenge ? (
          <>
            <InvitationForm
              auth={auth}
              initialCode={auth.pendingInvitation}
              onDone={() => setView("signin")}
              onRequireSignIn={() => setView("signin")}
            />
            <button type="button" className="text-button" onClick={() => setView("signin")}>
              Back to sign in
            </button>
          </>
        ) : auth.challenge ? (
          <form onSubmit={submitMfa} className="login-form">
            <label>
              Verification code
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={20}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                placeholder="123456 or a recovery code"
                required
              />
            </label>
            <button className="button primary" disabled={auth.busy}>
              {auth.busy ? "Checking…" : "Verify and continue"}
              <Check size={16} />
            </button>
            <button type="button" className="text-button" onClick={auth.cancelMfa}>
              Use a different account
            </button>
          </form>
        ) : (
          <form onSubmit={submit} className="login-form">
            <label>
              Work email
              <input
                autoFocus
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={12}
              />
            </label>
            <button className="button primary" disabled={auth.busy}>
              {auth.busy ? "Signing in…" : "Sign in"}
              <KeyRound size={16} />
            </button>
            <button type="button" className="text-button" onClick={() => setView("invite")}>
              I have an invitation
            </button>
          </form>
        )}
        {!auth.operatorConfigured && !auth.demoEnabled && (
          <div className="notice" role="status">
            <ShieldCheck size={16} />
            No operator account exists yet. Run <code>npm run setup:operator</code> to create the
            first platform administrator.
          </div>
        )}
        {auth.demoEnabled && !auth.challenge && (
          <div className="demo-access">
            <p className="nav-label">DEVELOPMENT PREVIEW</p>
            <p className="muted">
              Demonstration accounts for the fictional village. Not available in a real
              installation.
            </p>
            {demoProfiles[mode].map((entry) => (
              <button
                key={entry.profile}
                type="button"
                className="button secondary"
                disabled={auth.busy}
                onClick={() => void auth.useDemo(entry.profile)}
              >
                {entry.profile === "platform" ? (
                  <ShieldCheck size={16} />
                ) : entry.profile === "guard" ? (
                  <DoorOpen size={16} />
                ) : entry.profile === "resident" ? (
                  <Users size={16} />
                ) : (
                  <Building2 size={16} />
                )}
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <footer className="login-foot">
          <span>
            <ShieldCheck size={14} /> Thoughtful access. Peace of mind.
          </span>
        </footer>
      </section>
    </div>
  );
}
/**
 * Accepts an invitation. A new account chooses a name and password; an account that already exists
 * must be signed in, so the code field is the only input. The link carries its code, and the server
 * applies the same rule, so a token alone can never issue a session as somebody else.
 */
export function InvitationForm({
  auth,
  initialCode = "",
  onDone,
  onRequireSignIn,
}: {
  auth: Auth;
  initialCode?: string;
  onDone?: () => void;
  onRequireSignIn?: () => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const signedIn = !!auth.session;
  useEffect(() => {
    if (initialCode) return;
    const fromLink = new URLSearchParams(window.location.search).get("invite");
    if (fromLink) setCode(fromLink);
  }, [initialCode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accepted = await auth.acceptInvitation(
      code.trim(),
      signedIn ? undefined : name,
      signedIn ? undefined : password,
    );
    if (accepted) onDone?.();
  }
  return (
    <form onSubmit={submit} className="login-form">
      <label>
        Invitation code
        <input
          className="mono"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="Paste the code you were sent"
        />
      </label>
      {signedIn ? (
        <p className="form-note">
          Signed in as {auth.session?.principal.email}. The invitation will be added to this
          account.
        </p>
      ) : (
        <>
          <label>
            Your name
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Full name"
            />
          </label>
          <label>
            Choose a password
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </>
      )}
      <button className="button primary" disabled={auth.busy}>
        {auth.busy ? "Joining…" : "Accept invitation"}
        <Check size={16} />
      </button>
      {!signedIn && onRequireSignIn && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            auth.setPendingInvitation(code.trim());
            auth.setError("");
            onRequireSignIn();
          }}
        >
          I already have an account · sign in to accept
        </button>
      )}
    </form>
  );
}
export function PendingInvitationScreen({ mode, auth }: { mode: Mode; auth: Auth }) {
  return (
    <div className="login-shell">
      <section className="login-card">
        <div className="brand">
          <span className="brand-mark">
            <DoorOpen size={22} />
          </span>
          <span>
            smartgate<span className="brand-dot">.</span>
          </span>
        </div>
        <p className="eyebrow">{copy[mode].eyebrow}</p>
        <h1>Accept your village invitation</h1>
        <p className="subtitle">
          Signed in as {auth.session?.principal.email}. This invitation will be added to this
          account.
        </p>
        {auth.error && (
          <div className="notice warning" role="alert">
            {auth.error}
          </div>
        )}
        <InvitationForm
          auth={auth}
          initialCode={auth.pendingInvitation}
          onDone={auth.clearPendingInvitation}
        />
        <button type="button" className="text-button" onClick={auth.clearPendingInvitation}>
          Continue without accepting
        </button>
      </section>
    </div>
  );
}
/** Shown when an account legitimately belongs to more than one organization. */
export function OrganizationChooser({ mode, auth }: { mode: Mode; auth: Auth }) {
  const memberships = auth.session?.memberships ?? [];
  return (
    <div className="login-shell">
      <section className="login-card">
        <div className="brand">
          <span className="brand-mark">
            <DoorOpen size={22} />
          </span>
          <span>
            smartgate<span className="brand-dot">.</span>
          </span>
        </div>
        <p className="eyebrow">{copy[mode].eyebrow}</p>
        <h1>{memberships.length ? "Choose a village" : "No access yet"}</h1>
        <p className="subtitle">
          {memberships.length
            ? `Signed in as ${auth.session?.principal.email}. Select the organization you are working in.`
            : `Signed in as ${auth.session?.principal.email}. This account has no access at the moment. If you have been invited back, accept the invitation below.`}
        </p>
        {auth.error && (
          <div className="notice warning" role="alert">
            {auth.error}
          </div>
        )}
        {memberships.length ? (
          <div className="login-form">
            {memberships.map((membership) => (
              <button
                key={membership.membershipId}
                className="button secondary"
                disabled={auth.busy}
                onClick={() => void auth.selectOrganization(membership.organizationId)}
              >
                <Building2 size={16} />
                {membership.organizationName}
                <span className="muted">{membership.role.replace("_", " ")}</span>
              </button>
            ))}
            {auth.session?.platform_role && (
              <p className="form-note">
                Platform access to a customer organization requires an explicit, time-limited
                support grant recorded in the audit history.
              </p>
            )}
          </div>
        ) : (
          <InvitationForm auth={auth} />
        )}
        <button className="text-button" onClick={() => void auth.logout()}>
          <LogOut size={15} />
          Sign out
        </button>
      </section>
    </div>
  );
}
