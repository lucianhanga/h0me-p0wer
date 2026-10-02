// Battery temperature comfort bounds (°C) — ONE source for the simple
// view's ⚠ warning chips (SimpleHome TempChip, same semantics as
// battery.tempWarn.* in i18n) and the Graph tab's temperature-chart
// threshold lines (2026-10-02, user request: show the limits ON the
// graph). Cold at/below COLD_MAX: charging may be limited. Hot at/above
// HOT_MIN: sustained heat reduces performance and lifetime.
export const TEMP_COLD_MAX_C = 3;
export const TEMP_HOT_MIN_C = 35;
