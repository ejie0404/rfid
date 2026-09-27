"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  DoorOpen,
  Download,
  KeyRound,
  LogOut,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import type { Auth } from "./auth";

type Enrollment = { secret: string; otpauthUrl: string };

/** Groups a base32 key into blocks of four so it can be typed into an authenticator by hand. */
const groupKey = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

/** The API's error code when a privileged session has not enrolled MFA yet. */
export const MFA_SETUP_REQUIRED = "MFA_SETUP_REQUIRED";

/**
 * Shown instead of the workspace when a privileged account (platform staff or a village
 * administrator) signs in without MFA while the policy is on. The API refuses every other route
 * for this session, so enrollment is the only thing offered here.
 */
export function MfaSetupRequiredScreen({ api, auth }: { api: string; auth: Auth }) {
  const session = auth.session;
  return (
    <div className="login-shell">
      <div className="mfa-gate">
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
              <strong>{session?.principal.name}</strong>
              <small>{session?.principal.email}</small>
            </span>
            <button className="button secondary" onClick={() => void auth.logout()}>
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </header>
        <div className="notice warning" role="status">
          <ShieldCheck size={16} />
          This account can change access for other people, so SmartGate requires two-step
          verification before you continue.
        </div>
        <SecurityPanel api={api} auth={auth} />
      </div>
    </div>
  );
}

/**
 * Account security for the signed-in person: authenticator (TOTP) enrollment and the one-time
 * display of recovery codes. The server issues the key, verifies the first code, and revokes the
 * account's other sessions when enrollment completes; this screen only guides the steps.
 */
export function SecurityPanel({ api, auth }: { api: string; auth: Auth }) {
  const { session, token, onUnauthorized, markMfaEnabled, completeMfaSetup } = auth;
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const step = recoveryCodes ? "codes" : enrollment ? "enrolling" : "idle";

  // Each step replaces the panel's content, so focus follows it for keyboard and screen readers.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [step]);

  async function post(path: string, body: unknown = {}) {
    const response = await fetch(api + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token.current },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      onUnauthorized();
      throw new Error("Your session has ended. Sign in again.");
    }
    if (response.status === 409) {
      // The account is already protected, for example after enrolling in another tab.
      markMfaEnabled();
      completeMfaSetup();
      setEnrollment(null);
      throw new Error("Two-step verification is already on for this account.");
    }
    if (!response.ok)
      throw new Error(
        typeof payload.message === "string"
          ? payload.message
          : "The request could not be completed.",
      );
    return payload;
  }

  async function begin() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = await post("/auth/mfa/enroll");
      moved.current = true;
      setCode("");
      setEnrollment({ secret: String(payload.secret), otpauthUrl: String(payload.otpauth_url) });
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = await post("/auth/mfa/confirm", { code: code.trim() });
      moved.current = true;
      setRecoveryCodes(Array.isArray(payload.recovery_codes) ? payload.recovery_codes : []);
      setEnrollment(null);
      setCode("");
      setSaved(false);
      markMfaEnabled();
    } catch (issue) {
      setError((issue as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    moved.current = true;
    setEnrollment(null);
    setCode("");
    setError("");
  }

  function finish() {
    moved.current = true;
    setRecoveryCodes(null);
    setNotice("Two-step verification is on. You'll enter a code each time you sign in.");
    completeMfaSetup();
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

  const recoveryText = recoveryCodes
    ? [
        `SmartGate recovery codes for ${session?.principal.email ?? "your account"}`,
        "Each code works once, in place of an authenticator code.",
        "",
        ...recoveryCodes,
        "",
      ].join("\n")
    : "";

  function download() {
    const url = URL.createObjectURL(new Blob([recoveryText], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "smartgate-recovery-codes.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Recovery codes downloaded.");
  }

  const enabled = !!session?.mfa_enabled;
  return (
    <section className="panel security-panel" aria-labelledby="security-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            {step === "codes"
              ? "SAVE YOUR RECOVERY CODES"
              : step === "enrolling"
                ? "SET UP YOUR AUTHENTICATOR"
                : "TWO-STEP VERIFICATION"}
          </p>
          <h2 id="security-title" ref={heading} tabIndex={-1}>
            {step === "codes"
              ? "Keep these codes somewhere safe"
              : step === "enrolling"
                ? "Add SmartGate to your authenticator app"
                : enabled
                  ? "Two-step verification is on"
                  : "Protect your account with a second step"}
          </h2>
        </div>
        <span className={enabled ? "badge green" : "badge amber"}>
          <ShieldCheck size={13} />
          {enabled ? "On" : "Off"}
        </span>
      </div>
      <div className="security-body">
        <div className="security-live" role="status" aria-live="polite">
          {notice && <div className="notice">{notice}</div>}
        </div>
        {error && (
          <div className="notice warning" role="alert">
            {error}
          </div>
        )}
        {step === "idle" && enabled && (
          <p>
            Signing in to {session?.principal.email} needs your password and a six-digit code from
            your authenticator app. If you lose your phone, use one of your recovery codes instead.
          </p>
        )}
        {step === "idle" && !enabled && auth.demoEnabled && (
          <p>
            Demonstration accounts are shared, so two-step verification can't be turned on here. Use
            a real account created with the operator setup command or an invitation.
          </p>
        )}
        {step === "idle" && !enabled && !auth.demoEnabled && (
          <>
            <p>
              After your password, SmartGate will ask for a six-digit code from an authenticator app
              such as Google Authenticator, Microsoft Authenticator, or 1Password. Village and
              platform administrators should turn this on before managing residents or gates.
            </p>
            <p>
              Finishing setup signs you out on your other devices. It stays on for this account once
              enabled.
            </p>
            <div className="security-actions">
              <button className="button primary" onClick={() => void begin()} disabled={busy}>
                <KeyRound size={16} />
                {busy ? "Preparing…" : "Set up two-step verification"}
              </button>
            </div>
          </>
        )}
        {step === "enrolling" && enrollment && (
          <>
            <ol className="security-steps">
              <li>Open your authenticator app and choose to add an account.</li>
              <li>
                On this phone, use <strong>Open in authenticator</strong>. Otherwise, enter the
                setup key by hand as a time-based code.
              </li>
              <li>Type the six-digit code the app shows for SmartGate.</li>
            </ol>
            <dl className="security-key">
              <dt>Setup key</dt>
              <dd className="mono security-secret">{groupKey(enrollment.secret)}</dd>
            </dl>
            <div className="security-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => void copy(enrollment.secret, "Setup key")}
              >
                <Copy size={16} />
                Copy key
              </button>
              <a className="button secondary" href={enrollment.otpauthUrl}>
                <Smartphone size={16} />
                Open in authenticator
              </a>
            </div>
            <form className="security-form" onSubmit={confirm}>
              <label>
                Six-digit code
                <input
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  title="Enter the six digits shown in your authenticator app."
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                />
              </label>
              <button className="button primary" disabled={busy || code.length !== 6}>
                <Check size={16} />
                {busy ? "Checking…" : "Verify and turn on"}
              </button>
              <button type="button" className="text-button" onClick={cancel} disabled={busy}>
                Cancel
              </button>
            </form>
          </>
        )}
        {step === "codes" && recoveryCodes && (
          <>
            <p>
              Each code works once, in place of an authenticator code, if your phone is lost or
              replaced. They are shown only now and can't be viewed again.
            </p>
            <ul className="recovery-codes" aria-label="Recovery codes">
              {recoveryCodes.map((value) => (
                <li key={value} className="mono">
                  {value}
                </li>
              ))}
            </ul>
            <div className="security-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => void copy(recoveryText, "Recovery codes")}
              >
                <Copy size={16} />
                Copy codes
              </button>
              <button type="button" className="button secondary" onClick={download}>
                <Download size={16} />
                Download
              </button>
            </div>
            <label className="security-check">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I've saved these codes somewhere private
            </label>
            <div className="security-actions">
              <button className="button primary" onClick={finish} disabled={!saved}>
                <Check size={16} />
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
