import { useEffect, useState } from "react";
import { setToken } from "../auth.js";
import { useT } from "../i18n/LanguageProvider.jsx";

// Token prompt (2026-10-05, see server/auth.js and web/src/auth.js). Does
// NOT gate on "is a token stashed" — the backend's API_TOKEN is OPTIONAL
// (auth fails open when unset, see auth.js), so an instance that hasn't
// had a token configured yet must keep working with no prompt at all.
// Instead: render the app optimistically, and only show this prompt once
// an actual 401 has been observed (auth.js's wrapped fetch dispatches
// "auth:unauthorized" on any 401) — covers "no token yet," "wrong token,"
// and "expired token" the same way, as a reaction to the backend actually
// rejecting a request rather than a guess made in advance. Reuses the Ask
// feature's modal chrome (.ask-backdrop/.ask-panel) since this is
// visually the same "centered card over a dimmed backdrop" shape, just
// not dismissable.
export default function AuthGate({ children }) {
  const t = useT();
  const [unauthorized, setUnauthorized] = useState(false);
  const [input, setInput] = useState("");

  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, []);

  if (!unauthorized) return children;

  return (
    <div className="ask-backdrop">
      <div className="ask-panel card">
        <h4 style={{ marginTop: 0 }}>{t("auth.title")}</h4>
        <p className="muted">{t("auth.body")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = input.trim();
            if (!value) return;
            setToken(value);
            setUnauthorized(false);
          }}
        >
          <input
            className="pin-input token-input"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={t("auth.placeholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <div className="controls">
            <button type="submit" disabled={!input.trim()}>
              {t("auth.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
