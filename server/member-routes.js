export function respondMembers(res, from, to, devices) {
  devices.sort((a, b) => b.kwh - a.kwh);
  res.json({ ok: true, data: { from, to, devices } });
}
