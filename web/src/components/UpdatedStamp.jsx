// Consistent "last updated" line — rendered as the FIRST element of every
// tab so the timestamp always sits in the same place (right under the nav).
export default function UpdatedStamp({ at, children }) {
  return (
    <p className="muted updated-stamp">
      {at
        ? `updated ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
        : "updating…"}
      {children ? ` · ${children}` : ""}
    </p>
  );
}
