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
 * Cooldowns prevent the same signal from firing repeatedly in a short window.
 *
 * Return shape (matches analysis:update payload, source distinguishes from LLM):
 *   { tone_alert: { type, message }, suggestions: [], info_card: null, source: 'rule' }
 * or null when nothing notable.
 */

// ── Thresholds ─────────────────────────────────────────────

const TOO_FAST_WPM_THRESHOLD = 160;
const TOO_FAST_MIN_WORDS = 5;     // skip very short utterances
const LONG_MONOLOGUE_THRESHOLD = 5; // utterances before first trigger

// Minimum ms between repeated signals of the same type.
// Prevents the same coaching point from flooding the UI.
const COOLDOWN_MS = {
  price_objection: 30_000, // 30 s — topic doesn't change that fast
  too_fast:        15_000, // 15 s — allow re-alert after a sustained fast run
  long_monologue:  25_000, // 25 s — natural reminder interval
};

const PRICE_KEYWORDS = {
  tr: ['pahalı', 'fiyat', 'fiyatlar', 'bütçe', 'ücret', 'maliyet', 'masraf', 'para'],
  en: ['expensive', 'price', 'pricing', 'cost', 'budget', 'fee', 'costly', 'afford'],
};

// ── Pure signal detectors (stateless) ─────────────────────
// These return a raw signal or null. Cooldown is applied in the engine.

/**
 * @param {import('./transcriptSession.js').Utterance} latest
 */
function detectPriceObjection(latest) {
  const lower = latest.text.toLowerCase();
  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit = PRICE_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;

  return {
    tone_alert: {
      type: 'price_objection',
      message: lang === 'tr' ? 'Fiyat itirazı tespit edildi' : 'Price objection detected',
    },
    _debug: { keyword: hit },
  };
}

/**
 * Estimated WPM using elapsed time between the two most recent finals.
 * This is a lower-bound estimate (elapsed includes pause time between
 * utterances, not just speaking time), so threshold is set conservatively.
 *
 * @param {import('./transcriptSession.js').Utterance} latest
 * @param {import('./transcriptSession.js').Utterance | null} previous
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
      type: 'too_fast',
      message: lang === 'tr' ? 'Tempo çok hızlı' : 'Pace is too fast',
    },
    _debug: { wpm, wordCount: latest.wordCount, elapsedMs },
  };
}

/**
 * Fires once the utterance count reaches the threshold.
 * Cooldown in the engine controls how often it can repeat.
 *
 * @param {number} utteranceCount
 * @param {import('./transcriptSession.js').Utterance[]} contextWindow
 */
function detectLongMonologue(utteranceCount, contextWindow) {
  if (utteranceCount < LONG_MONOLOGUE_THRESHOLD) return null;

  const latest = contextWindow[contextWindow.length - 1];
  const lang = latest?.lang?.startsWith('tr') ? 'tr' : 'en';
  return {
    tone_alert: {
      type: 'long_monologue',
      message:
        lang === 'tr'
          ? 'Uzun konuşma — soru sormayı deneyin'
          : 'Long monologue — try asking a question',
    },
    _debug: { utteranceCount },
  };
}

// ── Engine factory (stateful, per-connection) ──────────────

/**
 * Creates a heuristics engine instance with its own cooldown state.
 * One engine per WebSocket connection — never share across connections.
 */
export function createHeuristicsEngine() {
  /** @type {Record<string, number>} signal type → last fired timestamp */
  const lastFiredAt = {};

  function isOnCooldown(type) {
    const cooldown = COOLDOWN_MS[type] ?? 0;
    const last = lastFiredAt[type] ?? 0;
    return Date.now() - last < cooldown;
  }

  function markFired(type) {
    lastFiredAt[type] = Date.now();
  }

  /**
   * Run all detectors and return the first signal that is not on cooldown.
   *
   * @param {{
   *   latest: import('./transcriptSession.js').Utterance,
   *   previous: import('./transcriptSession.js').Utterance | null,
   *   contextWindow: import('./transcriptSession.js').Utterance[],
   *   utteranceCount: number,
   * }} ctx
   * @returns {{ tone_alert, suggestions, info_card, source: 'rule', _debug? } | null}
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
      return {
        tone_alert: signal.tone_alert,
        suggestions: [],
        info_card: null,
        source: 'rule', // Phase 4 LLM responses will use source: 'llm'
        _debug: signal._debug,
      };
    }

    return null;
  }

  /** Reset cooldown state when a new listening session starts. */
  function reset() {
    for (const key of Object.keys(lastFiredAt)) {
      delete lastFiredAt[key];
    }
  }

  return { run, reset };
}
