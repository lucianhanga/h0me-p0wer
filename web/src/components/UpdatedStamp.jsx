import { useT } from "../i18n/LanguageProvider.jsx";

// Consistent "last updated" line — rendered as the FIRST element of every
// tab so the timestamp always sits in the same place (right under the nav).
// children render as a React node (NOT string-interpolated — a JSX fragment
// child is an array and would stringify with commas).
export default function UpdatedStamp({ at, children }) {
  const t = useT();
  return (
    <p className="muted updated-stamp">
      {at
        ? t("common.updated", {
            time: new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          })
        : t("common.updating")}
      {children ? <> · {children}</> : null}
    </p>
  );
}
