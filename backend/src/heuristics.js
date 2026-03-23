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
 *   1. emotionally_escalated — anger/frustration keywords from non-agent
 *   2. overwhelmed           — confusion/overload keywords from non-agent
 *   3. customer_closing      — dismissal/exit phrases from non-agent
 *   4. price_objection       — pricing keywords from non-agent
 *   5. over_persuading       — 3+ consecutive agent-only turns
 *   6. too_fast              — estimated WPM exceeds threshold
 *   7. long_monologue        — accumulated utterances exceed threshold
 *
 * Only the highest-priority signal that is NOT on cooldown is returned.
 * Cooldowns prevent the same signal from flooding the UI.
 *
 * Return shape:
 *   { source: 'rule', tone_alert: { type, message }, _debug? }
 * or null when nothing notable.
 */

// ── Thresholds ──────────────────────────────────────────────

const TOO_FAST_WPM_THRESHOLD    = 160;
const TOO_FAST_MIN_WORDS        = 5;
const LONG_MONOLOGUE_THRESHOLD  = 5;
const OVER_PERSUADING_THRESHOLD = 3; // consecutive agent-only turns

// Minimum ms between repeated signals of the same type.
const COOLDOWN_MS = {
  emotionally_escalated: 20_000,
  overwhelmed:           25_000,
  customer_closing:      30_000,
  price_objection:       30_000,
  over_persuading:       20_000,
  too_fast:              15_000,
  long_monologue:        25_000,
};

// ── Keyword banks ───────────────────────────────────────────

const PRICE_KEYWORDS = {
  tr: ['pahalı', 'fiyat', 'fiyatlar', 'bütçe', 'ücret', 'maliyet', 'masraf', 'para'],
  en: ['expensive', 'price', 'pricing', 'cost', 'budget', 'fee', 'costly', 'afford'],
};

// Signs the other party is emotionally escalated or frustrated.
// Conservative list — common Turkish/English frustration markers only.
const ESCALATION_KEYWORDS = {
  tr: ['saçmalık', 'kabul edemem', 'bu nasıl iş', 'memnun değilim', 'hayal kırıklığı', 'sinirli', 'kızgın', 'çok rahatsız'],
  en: ['ridiculous', 'unacceptable', 'not happy', 'frustrated', 'frustrating', 'upset', 'disappointed', 'this is crazy'],
};

// Signs the other party is confused or cognitively overloaded.
const OVERWHELMED_KEYWORDS = {
  tr: ['anlamıyorum', 'anlamadım', 'kafam karıştı', 'çok karmaşık', 'ne demek istiyorsunuz', 'çok fazla bilgi', 'takip edemiyorum'],
  en: ['confused', "don't understand", 'not following', 'too much information', 'overwhelmed', 'lost me', "can't follow"],
};

// Signs the other party is winding down or politely closing the conversation.
const CLOSING_KEYWORDS = {
  tr: ['düşüneceğiz', 'geri döneceğiz', 'şimdilik yeterli', 'zaman değil', 'ilgilenmiyoruz', 'devam edemeyiz', 'ilerleyemeyiz'],
  en: ["we'll think about it", "get back to you", 'not the right time', 'not interested', 'pass on this', "let's pause", 'move forward without'],
};

// ── Pure signal detectors (stateless) ──────────────────────

/**
 * Guardrail: other party shows frustration or anger.
 * De-escalate before any further persuasion attempt.
 */
function detectEmotionallyEscalated(latest) {
  if (latest.speaker === 'agent') return null;

  const lower = latest.text.toLowerCase();
  const lang  = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit   = ESCALATION_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;

  return {
    tone_alert: {
      type:    'emotionally_escalated',
      message: lang === 'tr'
        ? 'Gerilim yükseliyor; savunmaya geçme, önce gerilimi düşür.'
        : 'Tension rising — don\'t defend, de-escalate first.',
    },
    _debug: { keyword: hit },
  };
}

/**
 * Guardrail: other party signals confusion or cognitive overload.
 * Stop adding information — simplify and ask one short question.
 */
function detectOverwhelmed(latest) {
  if (latest.speaker === 'agent') return null;

  const lower = latest.text.toLowerCase();
  const lang  = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit   = OVERWHELMED_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;

  return {
    tone_alert: {
      type:    'overwhelmed',
      message: lang === 'tr'
        ? 'Karşı taraf bunalmış olabilir; basitleştir ve kısa soru sor.'
        : 'Customer may be overwhelmed — simplify and ask one short question.',
    },
    _debug: { keyword: hit },
  };
}

/**
 * Guardrail: other party is politely exiting or closing the door.
 * Pushing harder here typically backfires — ask a clarifying question instead.
 */
function detectCustomerClosing(latest) {
  if (latest.speaker === 'agent') return null;

  const lower = latest.text.toLowerCase();
  const lang  = latest.lang?.startsWith('tr') ? 'tr' : 'en';
  const hit   = CLOSING_KEYWORDS[lang].find((kw) => lower.includes(kw));
  if (!hit) return null;

  return {
    tone_alert: {
      type:    'customer_closing',
      message: lang === 'tr'
        ? 'Müşteri kapanıyor olabilir; zorlamak yerine netleştirici soru sor.'
        : 'Customer may be closing — ask a clarifying question, don\'t push.',
    },
    _debug: { keyword: hit },
  };
}

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
 * Guardrail: agent has spoken 3+ consecutive turns without the other side responding.
 * Only fires when speaker identity is known ('agent') — not in all-unknown or diarized sessions.
 */
function detectOverPersuading(contextWindow) {
  let consecutive = 0;
  for (let i = contextWindow.length - 1; i >= 0; i--) {
    if (contextWindow[i].speaker === 'agent') {
      consecutive++;
    } else {
      break;
    }
  }
  if (consecutive < OVER_PERSUADING_THRESHOLD) return null;

  const latest = contextWindow[contextWindow.length - 1];
  const lang   = latest?.lang?.startsWith('tr') ? 'tr' : 'en';
  return {
    tone_alert: {
      type:    'over_persuading',
      message: lang === 'tr'
        ? 'Üst üste konuşuyorsun; müşterinin tepkisini bekle.'
        : 'You\'ve been talking consecutively — pause and let them respond.',
    },
    _debug: { consecutive },
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

/**
 * Fires when the utterance count reaches the threshold AND the agent just spoke
 * without already asking a question.
 *
 * Guards:
 *   1. latest.speaker must be 'agent' — only warn when the agent just finished talking.
 *      If the customer spoke last, "ask a question" is not actionable advice.
 *   2. Suppress if the agent's text contains '?' — they are already questioning.
 *      Discovery-style turns like "Ne gibi sancılar yaşadınız? En büyük engel neydi?"
 *      should never trigger a "try asking a question" warning.
 */
function detectLongMonologue(utteranceCount, contextWindow) {
  if (utteranceCount < LONG_MONOLOGUE_THRESHOLD) return null;

  const latest = contextWindow[contextWindow.length - 1];

  // Guard 1: only meaningful when the agent just spoke
  if (latest?.speaker !== 'agent') return null;

  // Guard 2: agent is already asking — not a true monologue
  if (latest?.text?.includes('?')) return null;

  const lang = latest?.lang?.startsWith('tr') ? 'tr' : 'en';
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
      // ── Guardrails (highest priority — conversation safety) ──
      detectEmotionallyEscalated(latest),
      detectOverwhelmed(latest),
      detectCustomerClosing(latest),
      // ── Existing sales coaching signals ─────────────────────
      detectPriceObjection(latest),
      detectOverPersuading(contextWindow),
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
