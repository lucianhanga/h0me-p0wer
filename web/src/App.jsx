import { useEffect, useState } from "react";
import LiveTab from "./live/LiveTab.jsx";
import StrategyTab from "./strategy/StrategyTab.jsx";
import GraphTab from "./graph/GraphTab.jsx";
import Dashboard from "./dashboard/Dashboard.jsx";
import RoiTab from "./roi/RoiTab.jsx";
import WelcomeTab from "./welcome/WelcomeTab.jsx";
import AskButton from "./components/AskButton.jsx";
import ActivityBell from "./components/ActivityBell.jsx";
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
  const { isSimple, setView } = useView();
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

  // Swipe left/right to switch tabs (phones). Gestures starting on
  // interactive surfaces are ignored — the graph's drag-to-pan and the
  // buttons keep working. Horizontal must dominate vertical (scrolling
  // stays untouched), threshold 60px.
  useEffect(() => {
    let startX = null;
    let startY = 0;
    const onStart = (e) => {
      if (e.target.closest(".chart-box, button, a, select, input")) {
        startX = null;
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };
    const onEnd = (e) => {
      if (startX == null) return;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const i = PAGES.findIndex((p) => p.key === page);
      const next = (i + (dx < 0 ? 1 : -1) + PAGES.length) % PAGES.length;
      switchPage(PAGES[next].key);
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, [page]);

  return (
    <div className="app">
      <header>
        <h1>h0me-p0wer</h1>
        <AskButton />
        <ActivityBell />
        <button
          className={`view-toggle${isSimple ? " nav-active" : ""}`}
          onClick={() => setView(isSimple ? "full" : "simple")}
          title={isSimple ? t("view.fullTip") : t("view.simpleTip")}
          aria-label={isSimple ? t("view.fullTip") : t("view.simpleTip")}
        >
          {isSimple ? "◑" : "◉"}
        </button>
        <button
          className="lang-btn"
          onClick={() => setLanguage(LANGUAGES[(LANGUAGES.indexOf(language) + 1) % LANGUAGES.length])}
          title={t("header.languageTip")}
          aria-label={t("header.language")}
        >
          {{ en: "🇬🇧", de: "🇩🇪", ro: "🇷🇴" }[language]}
        </button>
        {!isSimple && (
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
        <span className="app-version">v{__APP_VERSION__}</span>
      </header>
      <main>
        {isSimple ? (
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
      <ViewProvider>
        <Shell />
      </ViewProvider>
    </LanguageProvider>
  );
}
