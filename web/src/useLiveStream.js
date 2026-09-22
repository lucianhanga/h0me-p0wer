import { useEffect, useState } from "react";

// Shared subscription to the server's live push channel (/ws, messages
// {type:"live", meter, flow} — see broadcastLive in server/index.js).
// ONE connection fanned out to every subscriber (LiveTab, BatteryTab), so
// two tabs never open two sockets; connects lazily on the first
// subscriber, closes when the last one unmounts (the server skips building
// payloads entirely when nobody is connected), reconnects with 2 s→30 s
// exponential backoff. Dev mode connects DIRECTLY to the backend — never
// through the Vite proxy (the documented EPIPE rule, AGENTS.md).
const subscribers = new Set();
let ws = null;
let backoff = 2000;
let reconnectTimer = null;

function connect() {
  if (ws || !subscribers.size) return;
  const url = import.meta.env.DEV
    ? "ws://localhost:3001/ws"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // malformed message — ignore
    }
    if (msg?.type !== "live") return;
    backoff = 2000; // healthy message — reset reconnect backoff
    // Deploy marker: the server piggybacks its app version on every push.
    // A tab still running an OLD bundle (opened before a deploy — the
    // 2026-09-22 "UI still updates at 5 s" report) reloads itself once,
    // the first time it sees a newer version.
    if (
      msg.v &&
      typeof __APP_VERSION__ !== "undefined" &&
      msg.v !== __APP_VERSION__ &&
      !sessionStorage.getItem("hp-reloaded")
    ) {
      sessionStorage.setItem("hp-reloaded", "1");
      location.reload();
      return;
    }
    for (const fn of subscribers) fn(msg);
  };
  ws.onclose = () => {
    ws = null;
    if (!subscribers.size) return;
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => ws.close();
}

function disconnect() {
  clearTimeout(reconnectTimer);
  backoff = 2000;
  if (ws) {
    ws.onclose = null; // intentional close — no reconnect
    ws.close();
    ws = null;
  }
}

// Returns the latest {type:"live", meter, flow} message (null until the
// first one arrives). Components merge the parts they need; nothing here
// replaces the slow REST polls for config/health data.
export function useLiveStream() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    subscribers.add(setMsg);
    connect();
    return () => {
      subscribers.delete(setMsg);
      if (!subscribers.size) disconnect();
    };
  }, []);
  return msg;
}
