"""
S-PAL <-> LLM wiring.

The deterministic :class:`~freehold_agent.policy.PolicyChecker` is the S-PAL trust
root — no LLM output ever adjudicates policy. The model's job here is
*composition*: turn a natural-language request from a business into a
:class:`~freehold_agent.spal.RequestContext` shape the checker can then decide on.

This module is the single hook where the S-PAL flow calls into the LLM. It
takes any backend that can constrain generation to a JSON schema (the
OpenAI-compatible backend in front of ``llama-server``, or Ollama) and
validates the result against the pydantic ``RequestContext`` model before
returning.
"""

from __future__ import annotations

import json

from pydantic import ValidationError

from freehold_agent.models.backend import StructuredBackend, StructuredOutputError
from freehold_agent.spal import RequestContext


class RequestContextError(StructuredOutputError):
    """The model's schema-constrained output did not validate as a ``RequestContext``.

    The backend's schema constraint guarantees the fields exist; this catches
    value-level violations the pydantic model rejects.
    """


_DEFAULT_SYSTEM_PROMPT = (
    "You are a privacy-policy assistant for the PCI (Personal Context "
    "Infrastructure) agent. Given a business's verification request, propose "
    "a JSON object describing the identity, proofs, retention and payment "
    "the user is willing to offer. Emit ONLY the JSON object — no prose, no "
    "code fences. The object MUST conform to the provided schema."
)


async def propose_request_context(
    backend: StructuredBackend,
    prompt: str,
    *,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> RequestContext:
    """Ask the LLM to synthesise a :class:`RequestContext` for policy evaluation.

    Args:
        backend: A backend with JSON-schema constrained output, usually the
            one the :class:`~freehold_agent.agent.Agent` has configured.
        prompt: Natural-language description of the incoming business
            request — e.g. "Foo Bar wants to verify age >= 18 for a
            purchase; user is happy to disclose an age ZKP but not their DOB".
        system_prompt: Optional override for the framing prompt.
        max_tokens / temperature: Forwarded to the backend.

    Returns:
        A validated :class:`RequestContext` ready to hand to
        :meth:`freehold_agent.policy.PolicyChecker.check`.

    Raises:
        RequestContextError: If the model returns JSON that doesn't validate
            against ``RequestContext``.
        OllamaError: On an Ollama backend's transport, timeout, schema or
            refusal failure.
        OpenAIError: The same for the OpenAI-compatible backend.
    """
    schema = RequestContext.model_json_schema()
    framing = system_prompt if system_prompt is not None else _DEFAULT_SYSTEM_PROMPT
    full_prompt = (
        f"{framing}\n\n"
        f"Schema (JSON):\n{json.dumps(schema)}\n\n"
        f"Business request:\n{prompt}\n\n"
        "Respond with the JSON object only."
    )
    response = await backend.generate_structured(
        full_prompt,
        schema,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    try:
        return RequestContext.model_validate(response.data)
    except ValidationError as exc:
        raise RequestContextError(f"Model produced an invalid RequestContext: {exc}") from exc
