import { useEffect, useState } from "react";
import LiveTab from "./live/LiveTab.jsx";
import StrategyTab from "./strategy/StrategyTab.jsx";
import GraphTab from "./graph/GraphTab.jsx";
import Dashboard from "./dashboard/Dashboard.jsx";
import RoiTab from "./roi/RoiTab.jsx";
import WelcomeTab from "./welcome/WelcomeTab.jsx";
import AskButton from "./components/AskButton.jsx";
import ActivityBell from "./components/ActivityBell.jsx";
import ActiveVisitors from "./components/ActiveVisitors.jsx";
import Hint from "./components/Hint.jsx";
import AuthGate from "./components/AuthGate.jsx";
import SimpleHome from "./simple/SimpleHome.jsx";
import { LanguageProvider, useLanguage, useT } from "./i18n/LanguageProvider.jsx";
import { ViewProvider, useView } from "./view/ViewProvider.jsx";
import { LANGUAGES } from "./i18n/translate.js";

const PAGES = [
  { key: "welcome", labelKey: "nav.welcome" },
  { key: "live", labelKey: "nav.live" },
  { key: "strategy", labelKey: "nav.strategy" },
  { key: "graph", labelKey: "nav.graph" },
  { key: "dashboard", labelKey: "nav.dashboard" },
  { key: "roi", labelKey: "nav.roi" },
];

function Shell() {
  const t = useT();
  const { language, setLanguage } = useLanguage();
  const { view, setView, views } = useView();
  const [page, setPage] = useState(() =>
    PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "welcome",
  );

  function switchPage(key) {
    setPage(key);
    location.hash = `#${key}`;
  }

  // Browser back/forward changes the hash — follow it.
  useEffect(() => {
    const onHash = () =>
      setPage(
        PAGES.some((p) => p.key === location.hash.slice(1)) ? location.hash.slice(1) : "welcome",
      );
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // No global swipe-to-switch-tabs (2026-09-29, user request): tab
  // navigation is the tab bar only. Horizontal swipes are reserved for the
  // period tiles, which navigate their own history (see SourceCard).

  return (
    <div className="app">
      <header>
        <h1 className="brand">
          h<span className="brand-zero">0</span>mep<span className="brand-zero">0</span>wer
        </h1>
        <AskButton />
        <ActivityBell />
        <button
          className={`view-toggle${view !== "full" ? " nav-active" : ""}`}
          onClick={() => setView(views[(views.indexOf(view) + 1) % views.length])}
          title={t(`view.${view}Tip`)}
          aria-label={t(`view.${view}Tip`)}
        >
          {{ full: "◉", simple: "◑" }[view]}
        </button>
        <button
          className="lang-btn"
          onClick={() => setLanguage(LANGUAGES[(LANGUAGES.indexOf(language) + 1) % LANGUAGES.length])}
          title={t("header.languageTip")}
          aria-label={t("header.language")}
        >
          {{ en: "🇬🇧", de: "🇩🇪", ro: "🇷🇴" }[language]}
        </button>
        {view === "full" && (
          <nav>
            {PAGES.map((p) => (
              <button
                key={p.key}
                className={page === p.key ? "nav-active" : ""}
                onClick={() => switchPage(p.key)}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </nav>
        )}
        <span className="app-version">
          v{__APP_VERSION__}
          <ActiveVisitors />
        </span>
      </header>
      <Hint id="header-controls">{t("hints.headerControls")}</Hint>
      <main>
        {view !== "full" ? (
          <SimpleHome />
        ) : page === "welcome" ? (
          <WelcomeTab />
        ) : page === "live" ? (
          <LiveTab />
        ) : page === "strategy" ? (
          <StrategyTab />
        ) : page === "graph" ? (
          <GraphTab />
        ) : page === "roi" ? (
          <RoiTab />
        ) : (
          <Dashboard />
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AuthGate>
        <ViewProvider>
          <Shell />
        </ViewProvider>
      </AuthGate>
    </LanguageProvider>
  );
}
