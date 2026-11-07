/**
 * A policy's terms, as a business reads them.
 *
 * The holder's service request carries the terms of the policy it is made
 * under (spec/protocols/policy-terms.md): the rules' scopes and conditions,
 * nothing that identifies the holder. This renders them as plain lines so
 * the person at the counter knows what they are agreeing to before the
 * verification is requested. Unknown shapes degrade to short notes rather
 * than throwing: the terms are data from another party.
 */

type Terms = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeConditions(conditions: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const identity = record(conditions.identity);
  if (identity?.type === "ephemeral_required") parts.push("the customer uses an ephemeral identity");
  if (Array.isArray(conditions.proofs)) {
    for (const proof of conditions.proofs) {
      const p = record(proof);
      if (p && typeof p.claim === "string") {
        const kind = p.type === "zkp" ? "zero-knowledge proof" : String(p.type ?? "proof");
        parts.push(`you receive a ${kind} of ${p.claim}`);
      }
    }
  }
  const retention = record(conditions.retention);
  if (retention) {
    parts.push(
      retention.max_seconds === 0
        ? "no retention of the result"
        : `retention up to ${String(retention.max_seconds)} seconds`,
    );
  }
  const derivatives = record(conditions.derivatives);
  if (derivatives) {
    const forbidden = ["training", "aggregation", "resale"].filter(
      (k) => derivatives[k] === "forbidden" || derivatives[k] === undefined,
    );
    if (forbidden.length > 0) parts.push(`no ${forbidden.join(", no ")}`);
  }
  const payment = record(conditions.payment);
  if (payment) parts.push(`payment of ${String(payment.amount)} ${String(payment.currency)}`);
  return parts;
}

/** One line per rule: the scope, then what the rule asks of the business. */
export function describeTerms(terms: Terms): string[] {
  const rules = Array.isArray(terms.rules) ? terms.rules : [];
  if (rules.length === 0) return ["No rules."];
  return rules.map((rule) => {
    const r = record(rule) ?? {};
    const scope = typeof r.context_scope === "string" ? r.context_scope : "?";
    const conditions = record(r.conditions);
    const parts = conditions ? describeConditions(conditions) : [];
    return parts.length > 0 ? `${scope}: ${parts.join("; ")}` : `${scope}: no conditions`;
  });
}
