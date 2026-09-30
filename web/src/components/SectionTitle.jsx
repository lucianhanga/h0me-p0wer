// Section divider for the simple view (2026-09-29, user request — "add
// some titles to each section, decorate a bit, make it look finished"):
// the minimal centered-text-with-hairlines pattern (standard dashboard
// composition widget — a divider adds structure without showing data).
// Decoration only — it renders no data and owns no behavior.
export default function SectionTitle({ children }) {
  // A real heading for screen readers (2026-09-29 review — was
  // aria-hidden, leaving the simple view with zero accessible structure).
  return (
    <div className="section-title" role="heading" aria-level={2}>
      <span>{children}</span>
    </div>
  );
}
