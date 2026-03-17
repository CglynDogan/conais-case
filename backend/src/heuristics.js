/**
 * heuristics.js
 *
 * Lightweight intake signal detectors. Run immediately on every finalized
 * utterance — no LLM call required.
 *
 * Usage:
 *   const engine = createHeuristicsEngine();   // one per connection
 *   const signal = engine.run({ latest, previous, contextWindow, utteranceCount });
 *   engine.reset();                             // called on session reset
 *
 * Detectors (in priority order):
 *   1. budget_signal          — price / cost / budget language → price_sensitive
 *   2. urgency_signal         — urgency / deadline language     → urgent
 *   3. decision_maker_unknown — partner / team / approval lang  → decision_maker_unknown
 *   4. hesitation             — hedging / uncertainty language  → hesitant
 *
 * Return shape:
 *   { signal_type: string, source: 'rule', _debug? }
 * or null when nothing notable.
 */

// ── Cooldowns ────────────────────────────────────────────────────────
// Minimum ms between repeated signals of the same type per session.

const COOLDOWN_MS = {
  budget_signal:          30_000,
  urgency_signal:         25_000,
  decision_maker_unknown: 40_000,
  hesitation:             20_000,
};

// ── Keyword banks ────────────────────────────────────────────────────

const BUDGET_KEYWORDS = {
  tr: ['pahalı', 'fiyat', 'fiyatlar', 'bütçe', 'ücret', 'maliyet', 'masraf', 'para', 'kısıtlı', 'sınırlı'],
  en: ['expensive', 'price', 'pricing', 'cost', 'budget', 'fee', 'costly', 'afford', 'limited', 'tight'],
};

const URGENCY_KEYWORDS = {
  tr: ['acil', 'hızlıca', 'en kısa sürede', 'urgently', 'asap', 'hemen', 'bekleyemeyiz', 'bu hafta', 'bu ay'],
  en: ['urgent', 'asap', 'immediately', 'right away', 'as soon as', 'can\'t wait', 'this week', 'deadline'],
};

const DECISION_MAKER_KEYWORDS = {
  tr: ['ortağım', 'ekibim', 'yöneticim', 'direktörüm', 'onay', 'karar veremem', 'birlikte karar', 'eşim', 'patronum'],
  en: ['partner', 'my team', 'manager', 'director', 'approval', 'can\'t decide', 'together', 'spouse', 'boss'],
};

const HESITATION_KEYWORDS = {
  tr: ['emin değilim', 'bilmiyorum', 'belki', 'düşünmem lazım', 'henüz netleşmedi', 'tam olarak değil', 'kararsızım'],
  en: ["not sure", "i don't know", "maybe", 'need to think', 'not clear yet', 'not entirely', 'undecided', 'unsure'],
};

// ── Pure detectors (stateless) ───────────────────────────────────────

/** @param {import('./transcriptSession.js').Utterance} latest */
function detectBudgetSignal(latest) {
  const lower = latest.text.toLowerCase();
  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit = BUDGET_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;
  return { signal_type: 'budget_signal', _debug: { keyword: hit } };
}

/** @param {import('./transcriptSession.js').Utterance} latest */
function detectUrgencySignal(latest) {
  const lower = latest.text.toLowerCase();
  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit = URGENCY_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;
  return { signal_type: 'urgency_signal', _debug: { keyword: hit } };
}

/** @param {import('./transcriptSession.js').Utterance} latest */
function detectDecisionMakerUncertainty(latest) {
  const lower = latest.text.toLowerCase();
  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit = DECISION_MAKER_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;
  return { signal_type: 'decision_maker_unknown', _debug: { keyword: hit } };
}

/** @param {import('./transcriptSession.js').Utterance} latest */
function detectHesitation(latest) {
  const lower = latest.text.toLowerCase();
  const lang = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit = HESITATION_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;
  return { signal_type: 'hesitation', _debug: { keyword: hit } };
}

// ── Engine factory (stateful, per-connection) ────────────────────────

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
   * @returns {{ signal_type: string, source: 'rule', _debug? } | null}
   */
  function run({ latest }) {
    const candidates = [
      detectBudgetSignal(latest),
      detectUrgencySignal(latest),
      detectDecisionMakerUncertainty(latest),
      detectHesitation(latest),
    ];

    for (const signal of candidates) {
      if (!signal) continue;
      if (isOnCooldown(signal.signal_type)) continue;
      markFired(signal.signal_type);
      return { signal_type: signal.signal_type, source: 'rule', _debug: signal._debug };
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
