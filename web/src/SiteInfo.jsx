import { useEffect, useState } from "react";

// Site list, scene summary and bound devices from the Anker cloud.
export default function SiteInfo() {
  const [sites, setSites] = useState(null);
  const [devices, setDevices] = useState(null);
  const [scene, setScene] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/cloud/sites")
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        const list = res.data?.site_list ?? [];
        setSites(list);
        if (list[0]) {
          fetch(`/api/cloud/scene?site_id=${list[0].site_id}`)
            .then((r) => r.json())
            .then((s) => s.ok && setScene(s.data))
            .catch(() => {});
        }
      })
      .catch((e) => setError(e.message));

    fetch("/api/cloud/bind-devices")
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        setDevices(res.data?.data ?? res.data);
      })
      .catch(() => {});
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!sites) return <p className="muted">loading…</p>;

  return (
    <div>
      <h3>Sites</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Site ID</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.site_id}>
              <td>{s.site_name}</td>
              <td className="mono">{s.site_id}</td>
              <td>{s.power_site_type ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {scene?.grid_info && (
        <>
          <h3>Grid (from cloud scene info)</h3>
          <table>
            <tbody>
              <tr>
                <td>Grid → home</td>
                <td>{scene.grid_info.grid_to_home_power} W</td>
              </tr>
              <tr>
                <td>PV → grid</td>
                <td>{scene.grid_info.photovoltaic_to_grid_power} W</td>
              </tr>
              <tr>
                <td>Grid status</td>
                <td>{scene.grid_info.grid_status}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      {Array.isArray(devices) && devices.length > 0 && (
        <>
          <h3>Devices</h3>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>SN</th>
                <th>PN</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d, i) => (
                <tr key={d.device_sn ?? i}>
                  <td>{d.device_name ?? d.alias_name ?? "—"}</td>
                  <td className="mono">{d.device_sn ?? "—"}</td>
                  <td>{d.device_pn ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
