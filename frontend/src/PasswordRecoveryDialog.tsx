import { useEffect, useRef, useState } from "react";
import { normalizeDigits } from "./utils/normalizeDigits";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";

type Props = {
  open: boolean;
  identifier: string;
  language: Language;
  t: Translator;
  onClose: () => void;
};

export function PasswordRecoveryDialog({ open, identifier: initialIdentifier, language, t, onClose }: Props) {
  const [step, setStep] = useState<"identify" | "code" | "password" | "success">("identify");
  const [identifier, setIdentifier] = useState("");
  const [flowId, setFlowId] = useState("");
  const [code, setCode] = useState<string[]>(Array(6).fill(""));
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [genericMessage, setGenericMessage] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const verifyingRef = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    setStep("identify");
    setIdentifier(initialIdentifier.trim());
    setFlowId("");
    setCode(Array(6).fill(""));
    setResetToken("");
    setNewPassword("");
    setConfirmation("");
    setLoading(false);
    setError("");
    setGenericMessage("");
    setSecondsLeft(0);
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open || secondsLeft <= 0) return undefined;
    const timer = window.setInterval(() => setSecondsLeft((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [open, secondsLeft]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, loading, onClose]);

  useEffect(() => {
    if (step !== "code" || code.join("").length !== 6 || verifyingRef.current) return;
    void verifyCode();
  }, [code, step]);

  if (!open) return null;

  async function sendCode(event?: React.FormEvent) {
    event?.preventDefault();
    if (loading || !identifier.trim()) {
      if (!identifier.trim()) setError(t("recovery.identifierRequired"));
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/teacher/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: identifier.trim(), language })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.flowId) throw new Error("request_failed");
      setFlowId(String(payload.flowId));
      setGenericMessage(String(payload.message || t("recovery.genericMessage")));
      setCode(Array(6).fill(""));
      setStep("code");
      setSecondsLeft(60);
      window.setTimeout(() => inputRefs.current[0]?.focus(), 0);
    } catch (_error) {
      setError(t("recovery.requestFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode() {
    if (verifyingRef.current || !flowId) return;
    verifyingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/teacher/verify-reset-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId, code: code.join(""), language })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok || !payload.resetToken) throw new Error("invalid_code");
      setResetToken(String(payload.resetToken));
      setStep("password");
    } catch (_error) {
      setError(t("recovery.invalidCode"));
      setCode(Array(6).fill(""));
      window.setTimeout(() => inputRefs.current[0]?.focus(), 0);
    } finally {
      verifyingRef.current = false;
      setLoading(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (loading) return;
    if (newPassword.length < 8) { setError(t("recovery.passwordLength")); return; }
    if (newPassword !== confirmation) { setError(t("recovery.passwordMismatch")); return; }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/teacher/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetToken, password: newPassword, confirmation, language })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "reset_failed");
      setStep("success");
      setNewPassword("");
      setConfirmation("");
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "password_mismatch" ? t("recovery.passwordMismatch") : t("recovery.resetFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function resend() {
    if (loading || secondsLeft > 0) return;
    await sendCode();
  }

  function updateCode(index: number, value: string) {
    const digits = normalizeDigits(value).replace(/\D/g, "");
    if (!digits) {
      setCode((current) => current.map((item, itemIndex) => itemIndex === index ? "" : item));
      return;
    }
    if (digits.length > 1) {
      const next = Array(6).fill("");
      digits.slice(0, 6).split("").forEach((digit, digitIndex) => { next[digitIndex] = digit; });
      setCode(next);
      inputRefs.current[Math.min(5, digits.length - 1)]?.focus();
      return;
    }
    setCode((current) => current.map((item, itemIndex) => itemIndex === index ? digits : item));
    if (index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleCodeKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !code[index] && index > 0) inputRefs.current[index - 1]?.focus();
    if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); inputRefs.current[index - 1]?.focus(); }
    if (event.key === "ArrowRight" && index < 5) { event.preventDefault(); inputRefs.current[index + 1]?.focus(); }
  }

  const title = step === "success" ? t("recovery.successTitle") : t("recovery.title");
  return <div className="modal-backdrop password-recovery-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !loading) onClose(); }}>
    <section className="modal-card password-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="password-recovery-title" dir={language === "ar" ? "rtl" : "ltr"}>
      <button className="modal-close-button" type="button" onClick={onClose} disabled={loading} aria-label={t("recovery.close")}>×</button>
      <p className="eyebrow">{t("recovery.eyebrow")}</p>
      <h2 id="password-recovery-title">{title}</h2>
      {step === "identify" ? <form onSubmit={sendCode}>
        <label htmlFor="recovery-identifier">{t("recovery.identifierLabel")}</label>
        <input id="recovery-identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" autoFocus />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={loading}>{loading ? t("recovery.sendingCode") : t("recovery.sendCode")}</button>
      </form> : null}
      {step === "code" ? <div>
        {genericMessage ? <p className="recovery-generic-message">{genericMessage}</p> : null}
        <p className="recovery-step-title">{t("recovery.enterCode")}</p>
        <div className="otp-inputs" dir="ltr" aria-label={t("recovery.enterCode")}>{code.map((value, index) => <input key={index} ref={(element) => { inputRefs.current[index] = element; }} value={value} onChange={(event) => updateCode(index, event.target.value)} onKeyDown={(event) => handleCodeKeyDown(index, event)} inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"} maxLength={6} aria-label={`${t("recovery.codeDigit")} ${index + 1}`} />)}</div>
        {loading ? <p className="form-hint" role="status">{t("recovery.verifying")}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="recovery-resend"><span>{t("recovery.resendQuestion")}</span><button type="button" onClick={() => void resend()} disabled={loading || secondsLeft > 0}>{secondsLeft > 0 ? t("recovery.resendIn", { seconds: String(secondsLeft) }) : t("recovery.resend")}</button></div>
      </div> : null}
      {step === "password" ? <form onSubmit={changePassword}>
        <label htmlFor="recovery-new-password">{t("recovery.newPassword")}</label>
        <div className="password-input-wrap"><input id="recovery-new-password" type={showPassword ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" autoFocus /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? t("recovery.hidePassword") : t("recovery.showPassword")}>{showPassword ? "◉" : "○"}</button></div>
        <label htmlFor="recovery-confirm-password">{t("recovery.confirmPassword")}</label>
        <input id="recovery-confirm-password" type={showPassword ? "text" : "password"} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={loading}>{loading ? t("recovery.changingPassword") : t("recovery.changePassword")}</button>
      </form> : null}
      {step === "success" ? <div className="recovery-success" role="status"><span aria-hidden="true">✓</span><p>{t("recovery.successDescription")}</p><button className="primary-button" type="button" onClick={onClose}>{t("recovery.backToLogin")}</button></div> : null}
    </section>
  </div>;
}
