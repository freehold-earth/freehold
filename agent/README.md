# Freehold Agent

Layer 2: Local AI agent for Personal Context Infrastructure.

## Overview

The Freehold Agent provides:

- **Local AI Processing** - Run language models on your device
- **Context Retrieval** - Query encrypted context store
- **Policy Enforcement** - Every decision runs against the holder's own S-PAL policies, kept in their vault
- **Decision Support** - AI-powered assistance without data leakage

## Installation

```bash
# Clone and install
git clone https://github.com/freehold-earth/freehold.git
cd freehold/agent
uv sync

# Optional: the in-process llama-cpp-python loader (single-executable fallback)
uv sync --extra llm
```

## Quick Start

Every link the agent has is TLS: to the model server, the context store and
the ZKP service, and its own API. One certificate authority covers the lot.
`infra/scripts/certs.sh` writes it and a certificate per service (the `infra/`
stack's `setup.sh` calls it the same way); start a model server with its
certificate and tell the agent what to trust:

```bash
../infra/scripts/certs.sh certs llama-server agent   # certs/ca.crt and certs/<name>.{key,crt}
llama-server -m models/Phi-3-mini-4k-instruct-q4.gguf \
  --ssl-key-file certs/llama-server.key --ssl-cert-file certs/llama-server.crt   # https://127.0.0.1:8080
export FREEHOLD_CA_FILE=$PWD/certs/ca.crt
```

To serve the coordination API, give it the agent's certificate; it is never
served in cleartext:

```bash
FREEHOLD_TLS_CERT_FILE=$PWD/certs/agent.crt FREEHOLD_TLS_KEY_FILE=$PWD/certs/agent.key \
  uv run python -m freehold_agent                      # https://127.0.0.1:8082
```

```python
from freehold_agent import Agent, AgentConfig

# The settings above, read from the environment; Agent() alone uses the
# built-in defaults and reads nothing. Inside the API the agent shares the
# client POST /unlock opens; on its own it builds one, and unlock() hands it
# the vault password, which it checks against a stored entry and then holds.
agent = Agent(AgentConfig.from_env())
await agent.initialize()
await agent.unlock("demo-user", vault_password)

# Ask about the holder's own data, under one of the holder's policies: the
# policy's rule for the scope must exist, and identity scopes are refused.
response = await agent.ask(
    "What are my upcoming appointments?",
    policy_name="calendar-access",
    context_scope="personal/calendar",
)

print(response.content, response.rule_id)
await agent.close()
```

## Where policies come from

A policy is the holder's data and lives in their context store, encrypted
like everything else, under `policies/{name}` where `name` is the last
segment of the policy id `spal:{owner DID}:{name}`. The agent reads a policy
through the unlocked vault at every decision; nothing is cached, so the
holder's edit is the next decision's policy. A policy is refused, with a
holder-facing reason, when it is absent (`policy not found`), does not
validate (`policy is not valid: <field paths>`; the values stay in the
vault and the full error goes to the agent's log only), is stored under a
name its id does not carry (`policy is not the one named`), or names an
owner other than the vault's root DID (`policy is not the holder's`).

A business never sees a policy id or owner. It sees the policy's **terms**,
the contractual content by allowlist (`spec/protocols/policy-terms.md`),
on the service request the holder makes, and sends back the hash of the
terms it accepts on its verification request. The agent resolves that hash
to a stored policy by hashing each of the holder's policies.

## Two decision paths, one gate

Both `ApprovalService.decide` (autonomous) and the approve button
(`POST /requests/{id}/approve`) run the same gate: the terms hash resolves
to a policy, the policy's most specific rule for the claim's scope decides,
and no rule is a denial. The request context states only what is true of
the request: the ephemeral DID the holder's app issued, when the approval
carries one, and the claim's own proof. The autonomous path has no user
action to issue a DID and the agent holds no root key to issue one, so a
rule that requires an ephemeral identity denies autonomous approvals and
approves through the button. That is the rule's meaning, not a gap.

**Reasons.** A denial by policy stores `not permitted by the holder's
policy`, which both parties can read. Which check failed is the holder's:
it is logged, and the approve call, which the holder's app makes, answers
403 with it. Details never carry a policy name, an owner, or a vault value.

## Ask

`POST /ask` with `{"question", "policy_name", "context_scope"}` is the one
path on which the holder's context reaches a model, and it is for the
holder's own app: a request from any other origin, or with no Origin at
all (a non-browser caller), is refused, and like the rest of this phase's
API the route has no authentication beyond that and is for a
loopback-bound agent reached from the holder's own machine. The same
origin check decides who reads holder-facing reasons on `/approve` and
`/service-requests`; every other caller gets the generic reason. The agent
refuses any scope that could read identity material before reading
anything (403): the `identity` domain, the `root-identity` key, the
`policies` domain (a policy carries the root DID as owner), and any domain
the reader would admit them to (`root/x` would admit `root-identity`);
private keys are dropped again at the key level. A scope reads its domain,
as an approval's claim does (`personal/age` reads the `personal` entries;
the store keys entries by domain, not by scope, so a rule's scope governs
the domain on this path until entries are keyed finer, noted on #42); requires the named policy to have a
rule governing the scope, evaluated for the holder, for whom the
third-party conditions (identity, proofs, derivatives, retention, payment)
are satisfied by definition (403 with the reason otherwise); then reads
the scope's entries and asks the model. A locked vault is 409, an
unreachable one 503, and `FREEHOLD_LLM_BACKEND=none` answers 503 `no model
backend configured` rather than a connection error. This is where the
compute-locality condition (#42) and the outbound audit line (#93) land.

## Architecture

```mermaid
flowchart TB
    subgraph Agent["Freehold Agent"]
        QH["Query Handler"]
        QH --> PC["Policy Checker"]
        QH --> CR["Context Retriever"]
        QH --> LLM["LLM Inference"]
    end

    PC --> SPAL["S-PAL Policy"]
    CR --> CS["Context Store"]
```

## Local Inference

Three backends sit behind one protocol. The default is the llama.cpp family
because it makes no outbound calls (ADR-006); the others are selected by
`FREEHOLD_LLM_BACKEND` or `LLMConfig.backend`. One set of settings serves all
three: `FREEHOLD_LLM_URL`, `FREEHOLD_LLM_MODEL`, `FREEHOLD_LLM_TIER`,
`FREEHOLD_LLM_API_KEY` and `FREEHOLD_LLM_TIMEOUT`.

The model server's address is always `https://`, like every address the
agent is given. Prompts, released context and the bearer token travel over
that link, so the agent refuses a plain `http://` address wherever it points,
loopback included; a certificate is cheap and the `infra/` stack generates
one. A server with a certificate of its own is trusted through
`FREEHOLD_CA_FILE`, the one file the agent trusts beside the system store on
every link.

- **`http`, the default: `llama-server`** from llama.cpp, or any server
  speaking the chat-completions protocol (llamafile, vLLM, LM Studio). The
  agent expects it at `https://127.0.0.1:8080/v1`, llama-server's own port
  with the TLS the stack gives it. The `infra/` stack starts it with a 2.3 GB
  Phi-3-mini so it fits any box; the tiers below are what the agent asks for
  by name. JSON-schema constrained output goes through `response_format`, so
  the S-PAL flow can synthesise validated `RequestContext` proposals on this
  backend.
- **`ollama`**: a local `ollama serve` daemon behind a TLS proxy, since
  Ollama serves plain HTTP only; `FREEHOLD_LLM_URL` is the proxy's address
  and has no default. Cross-platform, transparent MLX on Apple Silicon,
  constrained output via Ollama's `format` parameter. Ollama checks for
  updates and ships cloud features that need `OLLAMA_NO_CLOUD=1` to disable,
  which is why it is not the default.
- **`llamacpp`**: the in-process `llama-cpp-python` loader for a GGUF file,
  kept for single-executable demos. Needs the optional `llm` extra
  (`uv sync --extra llm`), with `FREEHOLD_LLM_MODEL` naming the file; it has
  no schema-constrained output, so `propose_request_context` is unavailable
  on it.

Named model tiers (`FREEHOLD_LLM_TIER`), used by both HTTP backends. With
`llama-server` the tier names the model the agent asks for; the server
answers with whichever GGUF file it loaded. Servers that validate model names
(LM Studio, vLLM, llama-server in router mode) reject a tier name they do not
serve, so set `FREEHOLD_LLM_MODEL` to the served name for those.

| Tier | Model tag | Notes |
|---|---|---|
| `default` | `qwen3.6:27b` | Primary tier. The weights are about 17 GB at Q4; the KV cache, the OS and the agent make up the rest, so it needs 24 GB or more, 32 GB with room to spare (ADR-004). |
| `small` | `phi4-mini:3.8b` | Fallback for <=8 GB RAM boxes. |

freehold-agent targets desktop and server runtimes; the mobile / on-device story lives in a separate native client (see ADR-006 in `docs/decisions`). This release does not expose an `on-device` tier — Bonsai-27B and similar Q1_0 models depend on `llama.cpp` backend support that isn't yet wired into every Ollama build (see [ollama/ollama#15359](https://github.com/ollama/ollama/issues/15359) for tracking).

Basic usage, on the default backend or with Ollama selected explicitly:

```python
from freehold_agent import Agent, AgentConfig, LLMConfig

agent = Agent(AgentConfig.from_env())  # or Agent() for the built-in defaults
# agent = Agent(AgentConfig(llm=LLMConfig(backend="ollama", url="https://127.0.0.1:11434")))
await agent.initialize()
try:
    # S-PAL wiring: synthesise a RequestContext for the policy checker
    request_ctx = await agent.propose_request_context(
        "Business wants age >= 18 verification for alcohol purchase."
    )
finally:
    await agent.close()
```

Integration smoke tests against a live server:

```bash
# llama-server (or any chat-completions server) at FREEHOLD_LLM_URL;
# the model is a name the server serves
FREEHOLD_LLM_MODEL=qwen3.6:27b uv run pytest -m openai

# Ollama behind a TLS proxy at FREEHOLD_LLM_URL
ollama pull phi4-mini:3.8b
FREEHOLD_LLM_URL=https://localhost:11435 FREEHOLD_LLM_MODEL=phi4-mini:3.8b uv run pytest -m ollama
```

## Docker

The `infra/` stack runs the agent with llama-server from the `llm` profile,
serving `MODEL_FILE` out of `MODELS_DIR`, over the certificate and API key
`infra/scripts/setup.sh` generates:

```bash
cd ../infra && ./scripts/setup.sh && docker compose up
```

See `infra/README.md` for the settings, and for running against Ollama on the
host behind a TLS proxy instead. The browser apps are the demo stack's; its
README says which certificates they need.

## Reading the context store

The context store is zero-knowledge: it holds entries the user's apps
encrypted with the user's password (AES-256-GCM under a PBKDF2 key, the
format in `context-store/src/crypto`), and the store itself never sees that
password. The agent decrypts entries itself, and holds no key until the user
gives it the password:

```bash
curl --cacert certs/ca.crt -X POST https://localhost:8082/unlock \
  -H 'Content-Type: application/json' \
  -d '{"user_id": "demo-user", "password": "..."}'   # 204; 401 if wrong; 503 if the store is down
curl --cacert certs/ca.crt -X POST https://localhost:8082/lock                      # forget it again
curl --cacert certs/ca.crt https://localhost:8082/health                            # {"vault": "locked" | "unlocked", ...}
```

The password is checked against a stored entry before it is held, and is
held in memory only, for the process; a failed attempt makes the next one
wait (0.5 s doubling to 8 s). The password is accepted if it opens any
vault-format entry, and an entry it does not open is skipped with a warning
when a scope is read, so one stray entry neither locks the user out nor
blocks its domain. `/unlock` and `/lock` refuse a browser origin outside
`FREEHOLD_CORS_ORIGINS` outright (403), since CORS alone would still let the
request run. Approving a request tied to a service request checks that the
unlocked vault is that service request's user's. The demo user app sends it after the
user unlocks the vault. Like the rest of the coordination API in this phase,
`/unlock` and `/lock` are unauthenticated and the agent binds loopback by
default; they are for a local agent reached from the user's own apps, not
for exposure beyond the machine. Until then approvals resolve as `error` with reason
`private data unavailable`; the cause (locked, unreachable, a field missing)
is logged, not stored on the request, which the business can also read.

A human approval that names an ephemeral DID is accepted only with the
holder's signature over the request (`spal/did-approval/v1`) and a record in
the unlocked vault that the vault's root issued that DID: the agent reads the
`root-identity` entry and the `identity` scope (the user app keeps records
under `identity/authorizations/`), rebuilds the record's canonical
`spal/did-authorization/v2` preimage with `freehold_preimage` and verifies
the root signature with the key the vault holds (`authorization.py`). The
approval says where the record is (`record_key`), so the check is two
reads and the vault is never searched. A DID without such a record is
refused (403), a locked vault cannot vouch and answers 409, an unreachable
store 503; in each case the request stays pending for a retry. The record
never leaves the vault.

What an approval reads is decided by the claim type, not by the business:
`CLAIM_INPUTS` in `services/approval.py` names the scope an `age` claim reads
(`personal/age`, the entries whose key is `personal` or starts with
`personal-` or `personal/`) and the one field it sends to the ZKP service
(`birthDate`). The policy is evaluated against that same scope. Nothing else
in the entries leaves the agent, and an unlisted claim type is denied before
any read.

An ask (`/ask`) reads the scope's entries whole, every field of each, and
puts them before the question. `ContextClient.search(query, scope, limit)`
remains for lexical lookup: one item per top-level field of each entry in
scope, ranked by the share of query terms found in the field's name or
value. Without a scope nothing is read.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEHOLD_HOST` | `127.0.0.1` | Bind address; loopback by default. The container sets `0.0.0.0` to accept external traffic |
| `FREEHOLD_PORT` | `8082` | API port. Bare `HOST` and `PORT`, which shells and platforms set for their own reasons, are not read |
| `FREEHOLD_TLS_CERT_FILE` | _(unset)_ | The certificate the API serves; with `FREEHOLD_TLS_KEY_FILE`, required to serve it. The API is never served in cleartext |
| `FREEHOLD_TLS_KEY_FILE` | _(unset)_ | The key for that certificate |
| `FREEHOLD_CA_FILE` | _(unset)_ | A certificate (or bundle) trusted beside the system store on every link, such as the stack's `ca.crt` |
| `FREEHOLD_CONTEXT_STORE_URL` | `https://localhost:8081` | Context store endpoint, `https://` only; the agent decrypts what it reads there (see below) |
| `FREEHOLD_ZKP_URL` | `https://localhost:8084` | ZKP service endpoint, `https://` only |
| `FREEHOLD_CARDANO_URL` | `https://localhost:8080` | Cardano API endpoint, `https://` only; a plain-HTTP devnet API goes behind a TLS proxy, as the `infra/` stack does |
| `FREEHOLD_CORS_ORIGINS` | the demo apps' origins (`https://localhost:4501`, `4502`, `3000`, `3001`) | Comma-separated browser origins allowed to call the API, `https://` only; never a wildcard |
| `FREEHOLD_HOLDER_ORIGINS` | the user app's origins (`https://localhost:4501`, `3000`) under the default allowlist; _(none)_ otherwise | The holder's own app, among the allowed origins: it alone may ask (`/ask`) and read holder-facing reasons. A custom `FREEHOLD_CORS_ORIGINS` names no holder page on its own, so without this nothing may ask and every reason is generic |
| `FREEHOLD_APPROVAL_MODE` | `manual` | Autonomous approval mode: `manual`, `auto_with_notification`, or `fully_autonomous` |
| `FREEHOLD_LLM_BACKEND` | `http` | `http` (llama-server or any chat-completions server), `ollama`, `llamacpp` (in-process), or `none` (no model; `/ask` says so) |
| `FREEHOLD_LLM_URL` | `https://127.0.0.1:8080/v1` | The model server, `https://` only, including the `/v1` root for the `http` backend. No default for `ollama`: it is the TLS proxy's address |
| `FREEHOLD_LLM_MODEL` | _(from tier)_ | Model name or tag the HTTP backends ask for, or the GGUF path the in-process loader opens |
| `FREEHOLD_LLM_TIER` | `default` | `default` (Qwen3.6-27B) or `small` (Phi-4-mini); the model asked for when `FREEHOLD_LLM_MODEL` is unset |
| `FREEHOLD_LLM_API_KEY` | _(unset)_ | Bearer token, if the server needs one |
| `FREEHOLD_LLM_TIMEOUT` | `120.0` | Per-request HTTP timeout (seconds) |

## Development

```bash
# Install with dev dependencies
uv sync --group dev

# Run tests
uv run pytest

# Type check
uv run mypy src/

# Lint
uv run ruff check src/

# Run the agent
uv run python -m freehold_agent
```

## Related Packages

- [spec](https://github.com/freehold-earth/freehold/tree/main/spec) - S-PAL schema and protocols
- [context-store](https://github.com/freehold-earth/freehold/tree/main/context-store) - Layer 1: Context Store
- [contracts](https://github.com/freehold-earth/freehold/tree/main/contracts) - Layer 3: Smart Contracts
- [zkp](https://github.com/freehold-earth/freehold/tree/main/zkp) - Layer 4: Zero-Knowledge Proofs
- [identity](https://github.com/freehold-earth/freehold/tree/main/identity) - Layer 5: DID Management

## License

Apache 2.0
