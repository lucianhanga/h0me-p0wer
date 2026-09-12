// Builds the deterministic fact base for the Welcome briefing. Everything
// here comes from local DB rows or the fetched weather/PVGIS payloads — the
// AI (welcome-ai call below) only interprets these numbers, never invents
// them.
import { getCloudTrend, getSnapshotRows, getFirstBatteryAfter } from "./db.js";
import { localDate } from "./welcome-sources.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const hhmm = (iso) => iso?.slice(11, 16) ?? null;

function dailyImportRows(sn, monthsBack = 2) {
  // cloud_history month rows: label = yyyy-MM-dd, import_energy per day.
  const rows = [];
  const now = new Date();
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = localDate(d).slice(0, 7);
    for (const r of getCloudTrend(sn, "month", ym).rows) {
      if (r.time && r.import_energy != null) rows.push({ date: r.time, importKwh: r.import_energy });
    }
  }
  return rows;
}

function avgImportByWeekday(rows) {
  const cutoff = localDate(new Date(Date.now() - 56 * 86400000));
  const acc = {}; // Mon -> {s, c}
  for (const r of rows) {
    if (r.date < cutoff) continue;
    const wd = WEEKDAYS[new Date(`${r.date}T12:00:00`).getDay()];
    (acc[wd] ??= { s: 0, c: 0 }).s += r.importKwh;
    acc[wd].c++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, round1(v.s / v.c)]));
}

export function buildContext({ config, geo, weather, pvgis, deps }) {
  const now = new Date();
  const sn = deps.getMeterSn();
  const daily = weather.daily;
  const dayRows = daily.time.map((t, i) => ({
    date: t,
    weekday: WEEKDAYS[new Date(`${t}T12:00:00`).getDay()],
    tempMin: daily.temperature_2m_min[i],
    tempMax: daily.temperature_2m_max[i],
    weathercode: daily.weathercode[i],
    precipProbMax: daily.precipitation_probability_max[i],
    sunHours: round1((daily.sunshine_duration[i] ?? 0) / 3600),
    radiationSumKwhM2: round1(daily.shortwave_radiation_sum[i]),
    sunrise: hhmm(daily.sunrise[i]),
    sunset: hhmm(daily.sunset[i]),
  }));

  // Today's grid import so far: trapezoid over 5 s samples (local, exact).
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let todayImportKwh = 0;
  const rows = getSnapshotRows(dayStart.getTime(), now.getTime()).filter((r) => r.grid_total != null);
  for (let i = 1; i < rows.length; i++) {
    const dtH = (rows[i].ts - rows[i - 1].ts) / 3600000;
    if (dtH > 0.25) continue;
    todayImportKwh += (((Math.max(rows[i - 1].grid_total, 0) + Math.max(rows[i].grid_total, 0)) / 2) * dtH) / 1000;
  }

  const imports = sn ? dailyImportRows(sn) : [];
  const ym = localDate().slice(0, 7);
  const mtd = imports.filter((r) => r.date.startsWith(ym) && r.date < localDate());
  const yearRows = sn
    ? getCloudTrend(sn, "year", String(now.getFullYear())).rows.map((r) => ({
        label: r.time, importKwh: round1(r.import_energy),
      }))
    : [];

  const batt = deps.getLiveBattery();
  const sunriseToday = daily.sunrise?.[0] ? new Date(daily.sunrise[0]).getTime() : dayStart.getTime();
  const sunriseBatt = getFirstBatteryAfter(sunriseToday);

  return {
    location: { address: config.address, lat: geo.lat, lon: geo.lon, displayName: geo.displayName },
    date: localDate(),
    weekday: WEEKDAYS[now.getDay()],
    monthName: MONTHS[now.getMonth()],
    tariffEurPerKwh: config.tariff,
    pvSystem: config.pv,
    sun: { sunrise: dayRows[0]?.sunrise, sunset: dayRows[0]?.sunset, sunHoursToday: dayRows[0]?.sunHours },
    today: dayRows[0] ?? null,
    week: dayRows,
    solarClimatology: pvgis,
    consumption: {
      avgImportKwhByWeekday: avgImportByWeekday(imports),
      monthToDateAvgImportKwh: mtd.length ? round1(mtd.reduce((a, r) => a + r.importKwh, 0) / mtd.length) : null,
      yearMonthlyAvgImportKwh: yearRows,
      todayImportKwhSoFar: round1(todayImportKwh),
    },
    battery: batt
      ? { socNow: batt.soc, outputW: batt.outputW, chargeW: batt.chargeW, sunriseSoc: sunriseBatt?.soc ?? null }
      : { socNow: null, outputW: null, chargeW: null, sunriseSoc: sunriseBatt?.soc ?? null },
  };
}
