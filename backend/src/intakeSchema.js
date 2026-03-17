/**
 * intakeSchema.js
 *
 * Defines the intake field set and field-status semantics
 * used across the intelligence layer.
 *
 * Status semantics:
 *   unknown  — field has not come up in the conversation at all.
 *   missing  — field was referenced or asked about but no usable answer was given.
 *   partial  — some information was given but it is vague, conditional, or incomplete.
 *   answered — customer gave a clear, explicit, actionable answer.
 *
 * Initial state is always "unknown" — not "missing".
 * A field only becomes "missing" once there is evidence it arose without resolution.
 *
 * Status is monotonically improving: unknown → missing → partial → answered.
 * mergeFieldStatus() enforces this — a field can only be promoted, never demoted.
 */

export const INTAKE_FIELDS = [
  'customer_goal',
  'urgency',
  'budget',
  'current_status',
  'prior_attempts',
  'main_constraint',
  'decision_maker',
  'timeline',
  'eligibility_risk',
  'next_step_readiness',
];

/** Status rank — higher number = more complete. */
export const STATUS_RANK = {
  unknown:  0,
  missing:  1,
  partial:  2,
  answered: 3,
};

/**
 * Returns a fresh field-status map with all fields set to 'unknown'.
 * @returns {Record<string, string>}
 */
export function initialFieldStatus() {
  return Object.fromEntries(INTAKE_FIELDS.map((f) => [f, 'unknown']));
}

/**
 * Merges an incoming field-status update into the current accumulated state.
 * A field's status can only move to a higher rank — never backwards.
 * Unknown values in the update are ignored.
 *
 * @param {Record<string, string>} current  Accumulated status map
 * @param {Record<string, string>} update   New status map from the latest LLM result
 * @returns {Record<string, string>}        New merged map (does not mutate inputs)
 */
export function mergeFieldStatus(current, update) {
  const merged = { ...current };
  for (const [field, newStatus] of Object.entries(update)) {
    if (!INTAKE_FIELDS.includes(field)) continue;          // ignore unknown fields
    const currentRank = STATUS_RANK[merged[field]] ?? 0;
    const newRank     = STATUS_RANK[newStatus]     ?? 0;
    if (newRank > currentRank) {
      merged[field] = newStatus;
    }
  }
  return merged;
}
