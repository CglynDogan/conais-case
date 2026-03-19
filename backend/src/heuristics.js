/**
 * heuristics.js
 *
 * Rule-based coaching signals. These run immediately on every finalized
 * utterance — no LLM call required.
 *
 * Usage:
 *   const engine = createHeuristicsEngine();   // one per connection
 *   const signal = engine.run({ latest, previous, contextWindow, utteranceCount });
 *   engine.reset();                             // called on session reset
 *
 * Signal priority (highest first):
 *   1. price_objection — keyword detected in latest utterance
 *   2. too_fast        — estimated WPM exceeds threshold
 *   3. long_monologue  — accumulated utterances exceed threshold
 *
 * Only the highest-priority signal that is NOT on cooldown is returned.
 * Cooldowns prevent the same signal from flooding the UI.
 *
 * Return shape:
 *   { source: 'rule', tone_alert: { type, message }, _debug? }
 * or null when nothing notable.
 */

// ── Thresholds ──────────────────────────────────────────────

const TOO_FAST_WPM_THRESHOLD  = 160;
const TOO_FAST_MIN_WORDS      = 5;
const LONG_MONOLOGUE_THRESHOLD = 5;

// Minimum ms between repeated signals of the same type.
const COOLDOWN_MS = {
  price_objection: 30_000,
  too_fast:        15_000,
  long_monologue:  25_000,
};

const PRICE_KEYWORDS = {
  tr: ['pahalı', 'fiyat', 'fiyatlar', 'bütçe', 'ücret', 'maliyet', 'masraf', 'para'],
  en: ['expensive', 'price', 'pricing', 'cost', 'budget', 'fee', 'costly', 'afford'],
};

// ── Pure signal detectors (stateless) ──────────────────────

/** @param {import('./transcriptSession.js').Utterance} latest */
function detectPriceObjection(latest) {
  // Only fire on customer/unknown speech — not on the agent's own pricing language
  if (latest.speaker === 'agent') return null;

  const lower = latest.text.toLowerCase();
  const lang  = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit   = PRICE_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;

  return {
    tone_alert: {
      type:    'price_objection',
      message: lang === 'tr' ? 'Fiyat itirazı tespit edildi' : 'Price objection detected',
    },
    _debug: { keyword: hit },
  };
}

/**
 * Estimated WPM using elapsed time between the two most recent finals.
 * Lower-bound estimate (elapsed includes pauses), threshold is conservative.
 */
function detectTooFast(latest, previous) {
  if (!previous) return null;
  if (latest.wordCount < TOO_FAST_MIN_WORDS) return null;

  const elapsedMs = latest.ts - previous.ts;
  if (elapsedMs <= 0) return null;

  const wpm = Math.round(latest.wordCount / (elapsedMs / 60_000));
  if (wpm <= TOO_FAST_WPM_THRESHOLD) return null;

  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  return {
    tone_alert: {
      type:    'too_fast',
      message: lang === 'tr' ? 'Tempo çok hızlı' : 'Pace is too fast',
    },
    _debug: { wpm, wordCount: latest.wordCount, elapsedMs },
  };
}

/** Fires once the utterance count reaches the threshold. */
function detectLongMonologue(utteranceCount, contextWindow) {
  if (utteranceCount < LONG_MONOLOGUE_THRESHOLD) return null;

  const latest = contextWindow[contextWindow.length - 1];
  const lang   = latest?.lang?.startsWith('tr') ? 'tr' : 'en';
  return {
    tone_alert: {
      type:    'long_monologue',
      message: lang === 'tr'
        ? 'Uzun konuşma — soru sormayı deneyin'
        : 'Long monologue — try asking a question',
    },
    _debug: { utteranceCount },
  };
}

// ── Engine factory (stateful, per-connection) ───────────────

export function createHeuristicsEngine() {
  /** @type {Record<string, number>} signal type → last fired timestamp */
  const lastFiredAt = {};

  function isOnCooldown(type) {
    const cooldown = COOLDOWN_MS[type] ?? 0;
    return Date.now() - (lastFiredAt[type] ?? 0) < cooldown;
  }

  function markFired(type) {
    lastFiredAt[type] = Date.now();
  }

  /**
   * @param {{
   *   latest:         import('./transcriptSession.js').Utterance,
   *   previous:       import('./transcriptSession.js').Utterance | null,
   *   contextWindow:  import('./transcriptSession.js').Utterance[],
   *   utteranceCount: number,
   * }} ctx
   * @returns {{ source: 'rule', tone_alert: { type: string, message: string }, _debug? } | null}
   */
  function run({ latest, previous, contextWindow, utteranceCount }) {
    const candidates = [
      detectPriceObjection(latest),
      detectTooFast(latest, previous),
      detectLongMonologue(utteranceCount, contextWindow),
    ];

    for (const signal of candidates) {
      if (!signal) continue;
      const type = signal.tone_alert.type;
      if (isOnCooldown(type)) continue;
      markFired(type);
      return { source: 'rule', tone_alert: signal.tone_alert, _debug: signal._debug };
    }

    return null;
  }

  function reset() {
    for (const key of Object.keys(lastFiredAt)) {
      delete lastFiredAt[key];
    }
  }

  return { run, reset };
}
