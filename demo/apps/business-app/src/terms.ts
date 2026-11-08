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

const DERIVATIVE_USES = ["training", "aggregation", "resale"] as const;
/** Whose machine may work on the data (S-PAL 1.1 custody), as the customer would say it. */
const CUSTODY_WORDING: Record<string, string> = {
  device_only: "the customer's own device only",
  owned_hardware: "hardware the customer controls",
  community_node: "a node run by someone the customer knows",
  federated_operator: "a federated operator, accountable through community governance",
  attested_enclave: "a verified secure enclave",
  any: "anyone",
};
/** A permission that is neither forbidden nor free carries an obligation; name it. */
const CONDITIONAL_PERMISSION: Record<string, string> = {
  requires_payment: "only against payment",
  requires_consent: "only with the customer's consent",
  anonymized_only: "only in anonymised form",
  allowed: "allowed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
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
  if (retention && typeof retention.max_seconds === "number") {
    parts.push(
      retention.max_seconds === 0
        ? "no retention of the result"
        : `retention up to ${String(retention.max_seconds)} seconds`,
    );
  }
  const derivatives = record(conditions.derivatives);
  if (derivatives) {
    // An absent permission is forbidden: that is the S-PAL default.
    const forbidden = DERIVATIVE_USES.filter(
      (k) => derivatives[k] === "forbidden" || derivatives[k] === undefined,
    );
    if (forbidden.length > 0) parts.push(`no ${forbidden.join(", no ")}`);
    for (const use of DERIVATIVE_USES) {
      const wording = CONDITIONAL_PERMISSION[String(derivatives[use])];
      if (wording) parts.push(`${use} ${wording}`);
    }
  }
  const payment = record(conditions.payment);
  if (payment) parts.push(`payment of ${String(payment.amount)} ${String(payment.currency)}`);
  const custody = record(conditions.custody);
  const operator = custody ? String(custody.operator) : "owned_hardware";
  parts.push(
    `the data may be worked on by ${CUSTODY_WORDING[operator] ?? operator}` +
      (custody ? "" : " (the default when a rule says nothing)"),
  );
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
