// Big-consumer "running now" report (2026-10-22, user request): a short
// AI-written line at the end of the simple view's first section saying
// which big appliances are currently running (washing machine, dryer,
// dishwasher, cooking — configurable via BIG_CONSUMERS).
//
// The AI is called ONLY on state transitions (start / end), never on a
// poll cycle — the report is cached and served until the next transition.
//
// Appliance cycles start-pause-restart (a washer idles at ~5 W between
// phases for many minutes), so "ended" requires the draw to stay below
// END_W for END_GRACE_MS — a short dip never closes a session.

import { fetchJson } from "./welcome-sources.js";

const START_W = 100; // draw that means "this appliance is working"
const END_W = 30; // below this the appliance is paused/idle
const END_GRACE_MS = 20 * 60 * 1000; // pause tolerance before "ended"
const MIN_AI_GAP_MS = 60 * 1000; // transition bursts collapse into one call

const DEFAULT_PATTERNS = ["waschmaschine", "trockner", "spüler", "spueler", "cooking", "dishwasher", "washer", "dryer"];

export function bigConsumerPatterns(env = process.env) {
  const raw = env.BIG_CONSUMERS;
  if (raw == null || raw.trim() === "") return DEFAULT_PATTERNS;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export class BigConsumerTracker {
  constructor({ patterns, onTransition = () => {} }) {
    this.patterns = patterns;
    this.onTransition = onTransition;
    this.groups = new Map(); // pattern -> { active, startedAt, belowSince, watts, name }
  }

  // plugs: [{ name, watts }] — the merged consumer list (aggregates like
  // "cooking" already collapsed). nowMs is injectable for dry-runs.
  sample(nowMs, plugs) {
    const sums = new Map(); // pattern -> { watts, name }
    for (const p of plugs) {
      const name = (p.name ?? "").toLowerCase();
      const pattern = this.patterns.find((pt) => name.includes(pt));
      if (!pattern || p.watts == null) continue;
      const g = sums.get(pattern) ?? { watts: 0, name: p.name };
      g.watts += p.watts;
      sums.set(pattern, g);
    }
    for (const pattern of this.patterns) {
      const reading = sums.get(pattern);
      if (!reading) continue; // consumer not present at all — keep state
      let st = this.groups.get(pattern);
      if (!st) {
        st = { active: false, startedAt: null, belowSince: null, watts: 0, name: reading.name };
        this.groups.set(pattern, st);
      }
      st.watts = reading.watts;
      st.name = reading.name;
      if (reading.watts >= START_W) {
        st.belowSince = null;
        if (!st.active) {
          st.active = true;
          st.startedAt = nowMs;
          this.onTransition("start", pattern);
        }
      } else if (reading.watts < END_W && st.active) {
        // Pause-tolerant end: only below END_W CONTINUOUSLY for the grace
        // period closes the session (washer between phases, cooker lid
        // open, dishwasher waiting on water temperature).
        st.belowSince ??= nowMs;
        if (nowMs - st.belowSince >= END_GRACE_MS) {
          st.active = false;
          this.onTransition("end", pattern);
        }
      } else {
        st.belowSince = null; // hysteresis band: neither starting nor pausing
      }
    }
  }

  activeList(nowMs = Date.now()) {
    const out = [];
    for (const st of this.groups.values()) {
      if (!st.active) continue;
      out.push({
        name: st.name,
        watts: Math.round(st.watts),
        sinceMin: Math.max(0, Math.round((nowMs - st.startedAt) / 60000)),
      });
    }
    return out.sort((a, b) => b.watts - a.watts);
  }
}

// Turns tracker transitions into a cached one-sentence report. AI calls
// happen only here, only on transitions, and never more often than
// MIN_AI_GAP_MS (a start/end burst regenerates once, after the gap).
export class BigConsumerReporter {
  constructor({ ai }) {
    this.ai = ai ?? { apiKey: "", baseUrl: "", model: "", language: "en" };
    this.report = null; // { text, active, generatedAt, ai }
    this.lastAiAt = 0;
    this.pendingTimer = null;
  }

  templateText(active) {
    const parts = active.map((c) => `${c.name} (${c.watts >= 1000 ? `${(c.watts / 1000).toFixed(1)} kW` : `${c.watts} W`})`);
    return `Running now: ${parts.join(", ")}`;
  }

  async callAi(active) {
    const lang = this.ai.language ?? "en";
    const list = active
      .map((c) => `${c.name}: ${c.watts} W, running for ${c.sinceMin} min`)
      .join("; ");
    const body = {
      model: this.ai.model,
      // Same body conventions as welcome-ai.js (verified against the
      // configured endpoint): reasoning models 400 on max_tokens and on an
      // explicit temperature — reasoning_effort is the accepted knob.
      reasoning_effort: "low",
      messages: [
        {
          role: "system",
          content:
            `You annotate a home-energy dashboard. Write ONE short sentence (max 18 words) ` +
            `telling the user which big appliances are running right now — factual, friendly, ` +
            `no greeting, no emoji, no advice. Reply in language code "${lang}".`,
        },
        { role: "user", content: `Currently running: ${list}` },
      ],
    };
    const j = await fetchJson(`${this.ai.baseUrl}/chat/completions`, {
      timeoutMs: 20000,
      method: "POST",
      headers: { Authorization: `Bearer ${this.ai.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = j?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty AI response");
    return text;
  }

  // kind: "start" | "end". Ends with nothing left running clear the report
  // WITHOUT an AI call (there is nothing to announce).
  async onTransition(kind, active) {
    if (!active.length) {
      this.report = null;
      return;
    }
    const wait = this.lastAiAt + MIN_AI_GAP_MS - Date.now();
    if (wait > 0) {
      // Collapse a transition burst into one regeneration after the gap.
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          this.regenerate(active).catch(() => {});
        }, wait);
        this.pendingTimer.unref();
      }
      return;
    }
    await this.regenerate(active);
  }

  async regenerate(active) {
    this.lastAiAt = Date.now();
    let text;
    let ai = true;
    try {
      if (!this.ai.apiKey) throw new Error("AI_API_KEY not set");
      text = await this.callAi(active);
    } catch (err) {
      console.warn(`[big-consumers] AI report failed (${err.message}) — template fallback`);
      text = this.templateText(active);
      ai = false;
    }
    this.report = { text, active, generatedAt: Date.now(), ai };
  }
}
