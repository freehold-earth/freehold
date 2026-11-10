import { useState } from "react";
import { askableScopes } from "./askScopes";
import { API_URL, apiErrorMessage } from "./api";
import { type AskAnswer, parseAskAnswer } from "./askAnswer";
import { type StoredPolicy, policyKeyName } from "./policies";

/** Domains the agent never sends to a model; not offered as ask scopes. */

/** The holder asks their agent about their own data, under one of their policies. */
export function AskBox({ policies, canAsk }: { policies: StoredPolicy[]; canAsk: boolean }) {
  const [question, setQuestion] = useState("How old am I?");
  const [policyKey, setPolicyKey] = useState<string>("");
  const [scope, setScope] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const chosen = policies.find((p) => p.key === policyKey) ?? policies[0];
  // The scopes an ask can be about: the chosen policy's rule scopes, less the
  // private ones the agent refuses whatever the policy says.
  const scopes = askableScopes(chosen?.policy.rules ?? []);
  const effectiveScope = scopes.includes(scope) ? scope : (scopes[0] ?? "");

  const handleAsk = async () => {
    if (!chosen) return;
    setAsking(true);
    setAskError(null);
    setAnswer(null);
    try {
      const res = await fetch(`${API_URL}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          policy_name: policyKeyName(chosen.policy),
          context_scope: effectiveScope,
        }),
      });
      if (res.ok) {
        // A 200 with another shape is not an answer; say so rather than render it.
        const parsed = parseAskAnswer(await res.json().catch(() => null));
        if (parsed) setAnswer(parsed);
        else setAskError("The agent's answer could not be read");
      } else {
        const data = await res.json().catch(() => ({}));
        setAskError(apiErrorMessage(data, `The agent could not answer (${res.status})`));
      }
    } catch (_err) {
      setAskError("Failed to connect to agent");
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: "0.5rem" }}>Ask your agent</h3>
      <p className="subtitle" style={{ marginBottom: "1rem" }}>
        A question about your own data, answered under one of your policies. The
        policy must have a rule for the scope; identity data is never sent to a model.
      </p>
      <div className="form-group">
        <label>Question</label>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} />
      </div>
      <div className="form-group">
        <label>Policy</label>
        <select value={chosen?.key ?? ""} onChange={(e) => setPolicyKey(e.target.value)}>
          {policies.map((p) => (
            <option key={p.key} value={p.key}>
              {p.policy.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label>Scope</label>
        <select value={effectiveScope} onChange={(e) => setScope(e.target.value)}>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <button
        className="btn-primary"
        onClick={handleAsk}
        disabled={asking || !chosen || !canAsk || !effectiveScope}
        title={canAsk ? undefined : "Unlock the agent's vault first"}
      >
        {asking ? "Asking..." : "Ask"}
      </button>
      {askError && <p style={{ marginTop: "0.75rem", color: "#dc2626" }}>{askError}</p>}
      {answer && (
        <div style={{ marginTop: "1rem", padding: "1rem", background: "#f0f9ff", borderRadius: "8px" }}>
          <p>{answer.answer}</p>
          <p style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#64748b" }}>
            Allowed by rule <code>{answer.rule_id}</code>; read {answer.context_used.length}{" "}
            {answer.context_used.length === 1 ? "entry" : "entries"}.
          </p>
        </div>
      )}
    </div>
  );
}
