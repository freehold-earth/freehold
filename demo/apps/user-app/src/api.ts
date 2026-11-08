/** The agent's coordination API: where it is, and how its errors read. */

export const API_URL = import.meta.env.VITE_API_URL || "https://localhost:8082";

// FastAPI's `detail` is a string for HTTPException but an array of validation
// objects for 422s; only strings are safe to render.
export function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const { detail, error } = data as { detail?: unknown; error?: unknown };
    if (typeof detail === "string") return detail;
    if (typeof error === "string") return error;
  }
  return fallback;
}
