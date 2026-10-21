export default function PeriodNavTitle({ label, onOlder, onNewer, olderDisabled, newerDisabled, t }) {
  return (
    <div className="tile-title src-title">
      <button className="src-nav" onClick={onOlder} disabled={olderDisabled} aria-label={t("dashboard.olderPeriod")}>
        ‹
      </button>
      <span>{label}</span>
      <button className="src-nav" onClick={onNewer} disabled={newerDisabled} aria-label={t("dashboard.newerPeriod")}>
        ›
      </button>
    </div>
  );
}
