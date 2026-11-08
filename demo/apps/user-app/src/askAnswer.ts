/** What `POST /ask` answers with; anything else is not shown on the page. */
export interface AskAnswer {
  answer: string;
  rule_id: string;
  context_used: string[];
}

/** The agent's answer if the body has its shape, else null: a 200 with another shape is not an answer. */
export function parseAskAnswer(data: unknown): AskAnswer | null {
  if (typeof data !== "object" || data === null) return null;
  const { answer, rule_id, context_used } = data as Record<string, unknown>;
  if (typeof answer !== "string" || typeof rule_id !== "string") return null;
  if (!Array.isArray(context_used) || !context_used.every((k) => typeof k === "string")) return null;
  return { answer, rule_id, context_used };
}
