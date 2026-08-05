// The billing period. Pure, so the boundary arithmetic is tested against dates that matter rather
// than against whatever day CI happens to run on.
//
// A UTC CALENDAR MONTH, keyed "YYYY-MM". Two properties make this the right choice for a first
// build, and both are about being un-clever:
//
//   It has no per-account state. An anniversary period (30 days from signup) needs a stored cycle
//   anchor per account, and every read of usage then depends on that anchor being right. A calendar
//   month is derivable from the clock alone, so a usage number can never be wrong because an anchor
//   drifted.
//
//   It has exactly one timezone, and it is UTC. "The month" in a local timezone means the period
//   boundary moves per user, so two accounts could disagree about which period a request belongs to,
//   and a DST transition would make one hour ambiguous. Clients are told the key is UTC.
//
// The cost accepted, stated plainly: a user who signs up on the 28th gets a short first period. That
// is a pricing/product concern to solve at the plan level (pro-rating, or a first-period grant), not
// a reason to make the meter's period definition depend on account state.

/** Period key for an instant, e.g. "2026-08". */
export function periodKey(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export interface PeriodBounds {
  key: string;
  /** Inclusive start, ISO 8601 with Z. */
  start: string;
  /** EXCLUSIVE end: the first instant of the next period. Half-open so consecutive periods tile with
   * no shared instant and no gap, which is what makes summing periods safe. */
  end: string;
}

export function periodBounds(now: Date = new Date()): PeriodBounds {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  // Month index 12 is January of the next year in Date.UTC, so December needs no special case.
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { key: periodKey(now), start: start.toISOString(), end: end.toISOString() };
}
