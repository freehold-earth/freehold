# Policies in the Context Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent evaluates every decision against a policy the holder keeps in their context store, businesses see and echo the policy's terms instead of its id, and the holder can ask their agent about their own data under a policy.

**Architecture:** One export function (TypeScript in the identity package, Python in the agent, shared vectors in the spec) turns a policy into its terms and terms hash. `PolicyChecker` reads policies from the vault through the existing `ContextReader`, resolves a business's terms hash to a stored policy, and evaluates with a `requester` kind. The service request carries terms to the business; the verification request carries the hash back; both decision paths and a new `POST /ask` route go through the checker.

**Tech Stack:** Python 3.11+, pydantic v2, FastAPI, httpx (agent); TypeScript, vitest, WebCrypto (identity package and demo apps); JSON Schema (spec).

**Spec:** `docs/superpowers/specs/2026-11-07-policies-in-the-context-store-design.md`

## Global Constraints

- No new environment variable. `FREEHOLD_LLM_BACKEND` gains the value `none`.
- Policy keys are `policies/{name}`; the owner DID never appears in a key, a business-facing payload, a stored response, or a prompt.
- Terms are produced only by the export function: `version`, `rules` reduced to `context_scope` and `conditions` and sorted by `context_scope` then canonical JSON, `enforcement.validators` sorted when present. Nothing else.
- Terms hash: lowercase hex SHA-256 of the RFC 8785 canonical JSON of the terms.
- No `allowed=True` without a `matched_rule_id`, on any path.
- Holder-facing reasons are logged and returned only to the holder's app; the business sees `not permitted by the holder's policy`.
- Commit style: atomic per task, why-focused body, `Part of #134`, no Claude trailers. Python: `uv run ruff check agent spec && uv run ruff format --check agent spec`, `uv run pytest -q` in `agent/` and `spec/`. TypeScript: `pnpm --filter <pkg> lint`, `typecheck` where defined, `test`, `build`.

## Review Focus

- A policy whose `rules` contain two rules with the same `context_scope` and different conditions: export must sort them deterministically by canonical JSON (Task 2, 3 vectors include this).
- A terms hash in uppercase hex, or 63 chars: `CreateVerificationRequest` must reject it with 422, not store it (Task 7).
- A `policy_name` containing `/` or `%`: the key is `policies/{name}` literally, percent-encoded on the wire, and must round-trip (Task 4 test).
- Two policies in the vault with identical terms: `policy_for_terms` must pick deterministically (first by key order) and the decision must not depend on dict order (Task 4 test).
- `POST /ask` with `context_scope: "identity/authorizations"` or `"root-identity"` while a policy rule covers everything: refused before any read (Task 8 test).

---

### Task 1: Protocol document and shared terms vectors

**Files:**
- Create: `spec/protocols/policy-terms.md`
- Create: `spec/schemas/spal/v1.0/terms-vectors.json`
- Test: `spec/tests/test_policy_terms.py`

**Interfaces:**
- Produces: `terms-vectors.json` with shape `{"vectors": [{"name": str, "policy": <S-PAL 1.0 policy>, "terms_canonical_json": str, "terms_hash": str}]}`. Tasks 2 and 3 test against it.

- [ ] **Step 1: Write the failing spec test**

```python
# spec/tests/test_policy_terms.py
VECTORS = json.loads((SCHEMA_DIR / "terms-vectors.json").read_text())["vectors"]

def test_vectors_cover_the_three_cases() -> None:
    assert {v["name"] for v in VECTORS} >= {"health-records", "employment", "unsorted-rules-with-handles"}

@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_terms_carry_only_contractual_keys(vector) -> None:
    terms = json.loads(vector["terms_canonical_json"])
    assert set(terms) <= {"version", "rules", "enforcement"}
    for rule in terms["rules"]:
        assert set(rule) == {"context_scope", "conditions"}
    if "enforcement" in terms:
        assert set(terms["enforcement"]) == {"validators"}
    assert re.fullmatch(r"[0-9a-f]{64}", vector["terms_hash"])
    assert hashlib.sha256(vector["terms_canonical_json"].encode()).hexdigest() == vector["terms_hash"]

@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_terms_omit_every_handle(vector) -> None:
    text = vector["terms_canonical_json"]
    for handle in (vector["policy"]["id"], vector["policy"]["owner"], vector["policy"]["name"]):
        assert handle not in text
    for rule in vector["policy"]["rules"]:
        assert f'"{rule["id"]}"' not in text
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spec && uv run pytest -q tests/test_policy_terms.py`
Expected: FAIL, file not found.

- [ ] **Step 3: Write `terms-vectors.json`**

Three vectors. `health-records` and `employment` take the policies from `spec/schemas/spal/v1.0/examples/` verbatim. `unsorted-rules-with-handles` is a minimal policy with `id` `spal:did:key:z6MkvectorOwner:unsorted`, `owner` `did:key:z6MkvectorOwner`, `name`, `description`, `created`, `updated`, `signature`, `enforcement: {"smart_contract": "addr1_x", "validators": ["midnight", "cardano"], "dispute_resolution": "dao:x"}` and three rules in the order `personal/email`, `personal/age`, `personal/age` (the two `personal/age` rules differ only in `retention.max_seconds` 0 and 3600, listed 3600 first). The expected terms sort them `personal/age` (max 0), `personal/age` (max 3600), `personal/email`, and `validators` to `["cardano", "midnight"]`. Compute `terms_canonical_json` by hand following RFC 8785 (keys sorted, no whitespace) and `terms_hash` with `sha256`. Task 2 will recompute every vector and the test there will catch a hand error.

- [ ] **Step 4: Write `spec/protocols/policy-terms.md`**

Sections, in this order: Purpose (what a business agrees to, without the holder's identity); Terms (the allowlist and the reductions, verbatim from Global Constraints, with a sentence on why each excluded field is excluded: identity, free text, instants, handles); Export (the algorithm as a numbered list: take `version`; for each rule take `context_scope` and `conditions`; sort rules by `context_scope` then by canonical JSON of the rule; if `enforcement` has `validators`, take them sorted; emit canonical JSON); Terms hash; Exchange (service request carries terms and hash to the business, verification request carries the hash back, response echoes it, authorization record `policyHash`); Who is asking (third-party conditions vs the holder's own asks, and that `processing` will bind the holder); Linkability (identical rules hash identically; a bespoke rule set is as linkable as bespoke contract text; a per-request nonce is the remedy if needed); Relation to `spal/commit/v1` (distinct; the datum alignment is #16); Test vectors (the file, and that the identity package and the agent both test against it).

- [ ] **Step 5: Run the spec test and lint**

Run: `cd spec && uv run pytest -q tests/test_policy_terms.py && cd .. && uv run ruff check spec && uv run ruff format --check spec`
Expected: PASS, all checks passed.

- [ ] **Step 6: Commit**

```bash
git add spec/protocols/policy-terms.md spec/schemas/spal/v1.0/terms-vectors.json spec/tests/test_policy_terms.py
git commit -m "Specify a policy's terms: what a business agrees to, without the holder" -m "Part of #134"
```

### Task 2: Python export and terms hash

**Files:**
- Create: `agent/src/freehold_agent/terms.py`
- Test: `agent/tests/test_terms.py`

**Interfaces:**
- Consumes: `canonical_json(value: object) -> str` from `freehold_agent.authorization`.
- Produces: `export_terms(policy: Mapping[str, object]) -> dict[str, object]`, `terms_hash(policy: Mapping[str, object]) -> str`, `TERMS_HASH_PATTERN = r"^[0-9a-f]{64}$"`. Tasks 4, 6, 7 use them.

- [ ] **Step 1: Write the failing tests**

```python
VECTORS = json.loads((Path(__file__).resolve().parents[2] / "spec/schemas/spal/v1.0/terms-vectors.json").read_text())["vectors"]

@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_export_reproduces_the_spec_vector(vector) -> None:
    assert canonical_json(export_terms(vector["policy"])) == vector["terms_canonical_json"]
    assert terms_hash(vector["policy"]) == vector["terms_hash"]

def test_export_is_an_allowlist() -> None:
    policy = {**VECTORS[0]["policy"], "persona": {"type": "personal"}}
    policy["rules"][0] = {**policy["rules"][0], "note": "x"}
    assert "persona" not in export_terms(policy)
    assert "note" not in export_terms(policy)["rules"][0]

def test_export_requires_version_and_rules() -> None:
    with pytest.raises(ValueError, match="rules"):
        export_terms({"version": "1.0"})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && uv run pytest -q tests/test_terms.py`
Expected: FAIL, `freehold_agent.terms` not found.

- [ ] **Step 3: Implement `terms.py`**

`export_terms` works on the plain mapping (not the pydantic model) so it can run before validation and on the identity side's data shape. Sort key for rules: `(rule["context_scope"], canonical_json(reduced_rule))`. `terms_hash` is `hashlib.sha256(canonical_json(export_terms(policy)).encode()).hexdigest()`. Module docstring points at `spec/protocols/policy-terms.md`.

- [ ] **Step 4: Run tests, lint**

Run: `cd agent && uv run pytest -q tests/test_terms.py && cd .. && uv run ruff check agent && uv run ruff format --check agent`
Expected: PASS. If a vector fails, fix the vector in Task 1's file (the hand computation), not the code, after confirming the code follows the protocol.

- [ ] **Step 5: Commit**

```bash
git add agent/src/freehold_agent/terms.py agent/tests/test_terms.py spec/schemas/spal/v1.0/terms-vectors.json
git commit -m "Export a policy's terms and hash them, as the terms protocol specifies" -m "Part of #134"
```

### Task 3: TypeScript export and terms hash in the identity package

**Files:**
- Create: `identity/src/terms.ts`
- Modify: `identity/src/index.ts` (export block)
- Test: `identity/tests/terms.test.ts`

**Interfaces:**
- Consumes: `canonicalJson(value: unknown): string` from `./preimage.js`.
- Produces: `export interface PolicyTerms { version: string; rules: Array<{ context_scope: string; conditions: Record<string, unknown> }>; enforcement?: { validators: string[] } }`, `exportTerms(policy: Record<string, unknown>): PolicyTerms`, `termsHash(policy: Record<string, unknown>): Promise<string>` (WebCrypto `crypto.subtle.digest("SHA-256", …)`, lowercase hex). Tasks 9 and 10 use them.

- [ ] **Step 1: Write the failing tests**

```ts
const spec = JSON.parse(readFileSync(new URL("../../spec/schemas/spal/v1.0/terms-vectors.json", import.meta.url), "utf8"))
describe("exportTerms", () => {
  it.each(spec.vectors)("reproduces the spec vector $name", async (v) => {
    expect(canonicalJson(exportTerms(v.policy))).toBe(v.terms_canonical_json)
    expect(await termsHash(v.policy)).toBe(v.terms_hash)
  })
  it("drops unknown fields rather than copying them", () => {
    const policy = { ...spec.vectors[0].policy, persona: { type: "personal" } }
    expect("persona" in exportTerms(policy)).toBe(false)
  })
  it("throws without rules", () => {
    expect(() => exportTerms({ version: "1.0" })).toThrow(/rules/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @freehold-earth/identity test -- terms`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `terms.ts` and export from `index.ts`**

Same algorithm as Task 2. Add a comment block in `index.ts`: `// Policy terms (spec/protocols/policy-terms.md)`.

- [ ] **Step 4: Run tests, lint, typecheck, build**

Run: `pnpm --filter @freehold-earth/identity test && pnpm --filter @freehold-earth/identity lint && pnpm --filter @freehold-earth/identity typecheck && pnpm --filter @freehold-earth/identity build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add identity/src/terms.ts identity/src/index.ts identity/tests/terms.test.ts
git commit -m "Export a policy's terms in the identity package, byte-identical to the agent" -m "Part of #134"
```

### Task 4: PolicyChecker reads policies from the vault

**Files:**
- Modify: `agent/src/freehold_agent/spal.py` (model validator on `SPALPolicy`)
- Modify: `agent/src/freehold_agent/policy.py` (whole class)
- Modify: `agent/src/freehold_agent/authorization.py` (add `root_did`)
- Modify: `agent/src/freehold_agent/seams.py` (`PolicyCheck` protocol)
- Create: `agent/tests/fakes.py` (shared fake vault)
- Test: `agent/tests/test_policy.py`, `agent/tests/test_spal_id.py`

**Interfaces:**
- Consumes: `ContextReader` (`entries(scope)`, `entry(key)`), `ContextEntry`, `export_terms`/`terms_hash` (Task 2), `ROOT_IDENTITY_KEY`.
- Produces, in `policy.py`:
  - `class Requester(StrEnum): THIRD_PARTY = "third_party"; HOLDER = "holder"`
  - `POLICY_KEY_PREFIX = "policies/"`; `def policy_key(name: str) -> str`
  - `GENERIC_DENIAL = "not permitted by the holder's policy"`
  - `PolicyCheckResult` gains `detail: str | None` (holder-facing) beside `reason` (generic for denials by policy; unchanged for allows).
  - `class PolicyChecker: def __init__(self, vault: ContextReader) -> None`
  - `async def policy_named(self, name: str) -> SPALPolicy` raises `PolicyRefused(detail)` (new, in `errors.py`, subclass of `ServiceError`) for invalid / mis-named / mis-owned; raises `ContextUnavailable` unchanged; a missing entry is `PolicyRefused("policy not found")`.
  - `async def policy_for_terms(self, terms_hash: str) -> SPALPolicy` raises `PolicyRefused("terms do not match any policy")`; iterates `entries("policies")` sorted by key, first match wins.
  - `async def check(self, policy: SPALPolicy, context_scope: str, request_context: RequestContext, requester: Requester) -> PolicyCheckResult`: no match → denied (`detail` names the scope); `HOLDER` skips the third-party conditions and allows with the matched rule.
- Produces, in `authorization.py`: `async def root_did(vault: ContextReader) -> str` raising `ContextUnavailable("root identity unreadable")` when the entry is missing or has no `did` string.
- Produces, in `seams.py`: `PolicyCheck` protocol with the three methods above.

- [ ] **Step 1: Write the failing id/owner tests (`test_spal_id.py`)**

```python
def test_id_must_embed_the_owner_and_name() -> None:
    SPALPolicy.model_validate(_policy("spal:did:key:z6Mkabc:age", "did:key:z6Mkabc", "age"))
    with pytest.raises(ValueError, match="id"):
        SPALPolicy.model_validate(_policy("spal:did:key:z6Mkother:age", "did:key:z6Mkabc", "age"))
def test_owner_must_be_a_did() -> None:
    with pytest.raises(ValueError, match="owner"):
        SPALPolicy.model_validate(_policy("spal:not-a-did:age", "not-a-did", "age"))
```

`SPALPolicy.name` is the human-readable name; the id's trailing segment is the policy's key name. Add `SPALPolicy.key_name` property returning the segment after the last colon.

- [ ] **Step 2: Write the shared fake (`tests/fakes.py`)**

`class FakeVault` implementing `entries(scope)` (filter keys by `in_domain`), `entry(key)`, with `put(key, data)` and an `error: Exception | None` to raise on every read. Move `_FakeContextClient` from `test_seams.py` onto it.

- [ ] **Step 3: Write the failing checker tests (replace the model-parsing and loading parts of `test_policy.py`; keep the condition-evaluation tests, adapting them to `check(policy, scope, ctx, Requester.THIRD_PARTY)`)**

Names and assertions:
- `test_policy_named_reads_policies_prefix`: vault has `policies/age` and `root-identity` `{"did": OWNER}`; `policy_named("age")` returns the policy.
- `test_policy_named_with_slash_in_name_round_trips`: name `a/b`, key `policies/a/b`.
- `test_missing_policy_is_refused`: `PolicyRefused` with `detail == "policy not found"`.
- `test_invalid_policy_is_refused_with_the_field_path`: entry carries `processing`; detail contains `rules.0.conditions.processing`.
- `test_mis_named_policy_is_refused`: stored under `policies/age` but id says `…:other`; detail `"policy is not the one named"`.
- `test_policy_not_the_holders_is_refused`: owner differs from `root-identity.did`; detail `"policy is not the holder's"`.
- `test_missing_root_identity_is_unavailable`: no `root-identity`; `ContextUnavailable`.
- `test_policy_for_terms_matches_by_hash` and `test_policy_for_terms_is_deterministic_for_identical_terms` (two policies with identical rules under `policies/a` and `policies/b`; result is `a`).
- `test_unmatched_terms_are_refused`.
- `test_no_matching_rule_denies`: `allowed is False`, `matched_rule_id is None`, `reason == GENERIC_DENIAL`, `detail` names the scope.
- `test_holder_requester_skips_third_party_conditions`: rule requires ephemeral identity and a proof; `check(..., RequestContext(), Requester.HOLDER)` allows with `matched_rule_id`.
- `test_denial_by_condition_carries_generic_reason_and_specific_detail`.

- [ ] **Step 4: Run to verify failure**

Run: `cd agent && uv run pytest -q tests/test_policy.py tests/test_spal_id.py`
Expected: FAIL on missing names.

- [ ] **Step 5: Implement**

`spal.py`: `model_validator(mode="after")` on `SPALPolicy`; the owner pattern is the schema's (copy the regex from `schema.json` `owner.pattern` into a module constant `OWNER_DID_PATTERN`). `policy.py`: `_load(entry, expected_name, holder_did) -> SPALPolicy` does validate → id/name → owner, raising `PolicyRefused`; `check` keeps the existing `_find_matching_rules` and `_evaluate_conditions`, the latter now returning `reason=GENERIC_DENIAL` with the former message as `detail`. Remove `load_policy`, `list_policies`, and the `policy_id`/`request_context is None` branches. Log refusals at warning with the key and detail.

- [ ] **Step 6: Run the agent suite, lint**

Run: `cd agent && uv run pytest -q && cd .. && uv run ruff check agent && uv run ruff format --check agent`
Expected: `test_policy.py`, `test_spal_id.py`, `test_seams.py` pass. `test_approval_service.py`, `test_api.py`, `test_agent.py`, `test_service_flow.py` may fail on the changed protocol; they are rewritten in Tasks 5 to 8. Record which fail.

- [ ] **Step 7: Commit**

```bash
git add agent/src/freehold_agent/spal.py agent/src/freehold_agent/policy.py agent/src/freehold_agent/authorization.py agent/src/freehold_agent/seams.py agent/src/freehold_agent/errors.py agent/tests/fakes.py agent/tests/test_policy.py agent/tests/test_spal_id.py agent/tests/test_seams.py
git commit -m "Read policies from the holder's vault and refuse what is not theirs" -m "Part of #134"
```

### Task 5: Both decision paths consult the policy

**Files:**
- Modify: `agent/src/freehold_agent/coordination.py` (`VerificationRequest`, `ApprovalDecision`)
- Modify: `agent/src/freehold_agent/seams.py` (`RequestContextBuilder`, `DeterministicContextBuilder`)
- Modify: `agent/src/freehold_agent/services/approval.py`
- Test: `agent/tests/test_approval_service.py`, `agent/tests/test_seams.py`

**Interfaces:**
- Consumes: `PolicyChecker.policy_for_terms`, `check`, `Requester`, `PolicyRefused`, `GENERIC_DENIAL` (Task 4).
- Produces:
  - `VerificationRequest.terms_hash: str` replaces `policy_id`.
  - `ApprovalDecision.detail: str | None` (holder-facing); `reason` stays business-facing.
  - `RequestContextBuilder.build(request: VerificationRequest, requester_did: str | None) -> RequestContext`.
  - `DeterministicContextBuilder.build` returns `RequestContext(identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did=requester_did) if requester_did else None, proofs=[AvailableProof(type=ProofType.ZKP, claim=request.claim.type)])`.
  - `ApprovalService.decide(request)` and `approve(request, requester_did)` both: resolve `policy_for_terms(request.terms_hash)` (`PolicyRefused` → `DENY`, `reason=GENERIC_DENIAL`, `detail=exc.detail`), build the context with the DID (None on `decide`), `check(..., Requester.THIRD_PARTY)`, deny unless `allowed and matched_rule_id`, then fetch and prove as today.

- [ ] **Step 1: Write the failing tests**

In `test_seams.py`: `test_builder_states_the_did_when_given`, `test_builder_states_no_identity_without_a_did`, `test_builder_states_the_claims_proof`.

In `test_approval_service.py` (replace `FakePolicy` with a fake implementing `policy_for_terms`/`check`): `test_decide_denies_when_terms_match_no_policy` (reason generic, detail specific), `test_decide_denies_ephemeral_identity_rule_because_autonomous_has_no_did`, `test_decide_approves_a_policy_without_identity_condition`, `test_approve_consults_the_policy_with_the_did` (a rule requiring ephemeral identity approves with a DID and denies without), `test_approve_denied_by_policy_generates_no_proof` (the fake ZKP records no call), `test_default_allow_without_matched_rule_does_not_approve` (keep), `test_context_unavailable_while_reading_the_policy_errors`.

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && uv run pytest -q tests/test_approval_service.py tests/test_seams.py`
Expected: FAIL.

- [ ] **Step 3: Implement**

Factor the shared gate into `async def _permitted(self, request, requester_did) -> tuple[ApprovalDecision | None, str | None]` returning a denial or the matched rule id. Delete the `approve` docstring sentence "Skips the policy gate entirely" and describe the gate. Update the `DeterministicContextBuilder` docstring to state what it asserts and why the autonomous path has no identity.

- [ ] **Step 4: Run, lint**

Run: `cd agent && uv run pytest -q tests/test_approval_service.py tests/test_seams.py tests/test_policy.py && cd .. && uv run ruff check agent && uv run ruff format --check agent`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/freehold_agent/coordination.py agent/src/freehold_agent/seams.py agent/src/freehold_agent/services/approval.py agent/tests/test_approval_service.py agent/tests/test_seams.py
git commit -m "Every decision consults the holder's policy, by button as well as autonomously" -m "Part of #134"
```

### Task 6: Terms travel on the service request

**Files:**
- Modify: `agent/src/freehold_agent/coordination.py` (`ServiceRequest`, `CreateServiceRequest`)
- Modify: `agent/src/freehold_agent/services/service_requests.py` (`create`)
- Test: `agent/tests/test_service_requests.py` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `export_terms`, `terms_hash` (Task 2); `SPALPolicy`.
- Produces:
  - `CreateServiceRequest.policy_name: str` (pattern `^[^:\x00-\x1f\x7f]{1,200}$`).
  - `class PolicyLabel(BaseModel): name: str; description: str | None`.
  - `ServiceRequest.terms: dict[str, object]`, `terms_hash: str`, `policy_label: PolicyLabel`.
  - `service_requests.create(repo, payload, policy: SPALPolicy) -> ServiceRequest` computes terms, hash and label from `policy.model_dump(mode="json", exclude_none=True)`.

- [ ] **Step 1: Write the failing tests**

`test_create_attaches_terms_hash_and_label` (terms equal `export_terms(policy dump)`, hash equals `terms_hash`, label is name and description); `test_service_request_carries_no_owner_or_id` (serialize the model to JSON, assert the owner DID and policy id are absent).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**, **Step 4: Run and lint** as in the tasks above.

- [ ] **Step 5: Commit**

```bash
git commit -am "Carry a policy's terms, not its id, on the service request a business reads" -m "Part of #134"
```

### Task 7: API: terms in, hash back, reasons split

**Files:**
- Modify: `agent/src/freehold_agent/api.py`
- Modify: `agent/src/freehold_agent/store.py` only if `ServiceRequestRepository` needs nothing (check; likely unchanged)
- Test: `agent/tests/test_api.py`, `agent/tests/test_service_flow.py`, `agent/tests/test_api_unlock.py` (fixture reuse)

**Interfaces:**
- Consumes: Tasks 4 to 6.
- Produces:
  - `CreateVerificationRequest.terms_hash: str` with `pattern=TERMS_HASH_PATTERN`; `policy_id` removed.
  - `POST /service-requests` requires the vault unlocked (409 `the vault is locked` on `ContextLocked`, 503 on other `ContextUnavailable`), loads `policy_named(payload.policy_name)` (`PolicyRefused` → 422 with `detail`), passes the policy to `service_requests.create`.
  - `_default_service_factory` builds `ApprovalService(PolicyChecker(context_client), DeterministicContextBuilder(), ContextStoreDataProvider(context_client), zkp_client)`.
  - `_response(...)` stores `reason`, `proof`, `requester_did`, `attestation`, and `terms_hash` (echo).
  - `POST /requests/{id}/approve`: when the decision is `DENY` with a `detail`, store the request as `DENIED` with the generic reason, then respond `403` with `detail`.
  - `POST /requests` autonomous path: on `DENY` store generic reason; `detail` is logged only.

- [ ] **Step 1: Build the shared API fixture**

In `test_api.py`, a `_vault(policy: dict | None = None, root_did: str = OWNER) -> ContextClient` using `FakeStore` from `test_context.py` with `root-identity` and `policies/age-verification` entries, unlocked through `POST /unlock` in a helper `_unlocked_client(app) -> TestClient`. The seeded policy is the one Task 9 seeds (write it once as `SEED_POLICY` in `tests/fakes.py`; Task 9 mirrors it in TypeScript).

- [ ] **Step 2: Write the failing tests**

- `test_create_request_requires_a_terms_hash` (422 without; 422 on uppercase hex).
- `test_create_request_stores_no_policy_id` (`policy_id` not in the JSON).
- `test_service_request_attaches_terms_and_hash_from_the_vault`.
- `test_service_request_for_unknown_policy_is_422_with_detail`.
- `test_service_request_while_locked_is_409`.
- `test_approve_denied_by_policy_is_403_and_stored_denied_with_generic_reason` (seeded policy, approve with no DID → 403 `detail` mentions identity; `GET /requests/{id}` shows `status denied`, `response.reason == GENERIC_DENIAL`, no detail).
- `test_approve_with_did_under_seeded_policy_approves` (reuse the signed-approval helpers already imported in `test_api.py`; stub ZKP via `service_factory` is no longer enough because the policy gate runs inside the real service, so inject a real `ApprovalService` with `FakeZKP` from `test_approval_service.py`).
- `test_response_echoes_the_terms_hash`.
- `test_autonomous_deny_stores_generic_reason_only`.
- In `test_service_flow.py`, run the full flow: unlock → service request with `policy_name` → business reads terms and posts a verification with that hash → approve with DID → `verified`; and the negative: a wrong hash → denied.

- [ ] **Step 3: Run to verify failure**, **Step 4: Implement**, **Step 5: Run the whole agent suite and lint**

Run: `cd agent && uv run pytest -q && cd .. && uv run ruff check agent && uv run ruff format --check agent`
Expected: everything passes except `test_agent.py` (Task 8).

- [ ] **Step 6: Commit**

```bash
git add agent/src/freehold_agent/api.py agent/tests/test_api.py agent/tests/test_service_flow.py agent/tests/fakes.py
git commit -m "Businesses send the terms hash they accept and get it echoed; the holder sees why a denial happened" -m "Part of #134"
```

### Task 8: The ask route, the reshaped Agent, and the `none` backend

**Files:**
- Modify: `agent/src/freehold_agent/config.py` (`Backend` literal, `_backend_from_env`, `_url_for_the_backend`)
- Modify: `agent/src/freehold_agent/agent.py`
- Modify: `agent/src/freehold_agent/api.py` (`POST /ask`)
- Test: `agent/tests/test_config_env.py`, `agent/tests/test_agent.py`, `agent/tests/test_api_ask.py`

**Interfaces:**
- Consumes: `PolicyChecker.policy_named`, `check(..., Requester.HOLDER)`; `ContextClient.entries(scope)`; `scope_domain`.
- Produces:
  - `Backend = Literal["http", "ollama", "llamacpp", "none"]`; under `none`, `url` is `None` and `Agent.initialize` loads nothing.
  - `class NoModelBackend(ServiceError)` in `errors.py`, message `no model backend configured`.
  - `Agent.__init__(self, config: AgentConfig | None = None, *, context_client: ContextClient | None = None)`; the app passes its client. `unlock`/`lock`/`is_unlocked` removed from `Agent` (the client owns them).
  - `REFUSED_ASK_DOMAINS = frozenset({"identity", "root-identity"})` in `agent.py`.
  - `async def ask(self, question: str, policy_name: str, context_scope: str) -> AgentResponse`; `AgentResponse` fields: `content: str`, `context_used: list[str]` (entry keys), `rule_id: str`, `timestamp`. Order inside: refuse domain (`PolicyRefused("identity scopes are never sent to a model")`) → `policy_named` → `check(HOLDER)`; denied → `PolicyRefused(detail)` → `entries(context_scope)` (raise `ContextUnavailable` unchanged) → build prompt from `entry.fields()` → backend; `none` → `NoModelBackend`. `process` and `propose_request_context` are removed; `_build_prompt` takes entries.
  - `class AskRequest(BaseModel): question: str (max_length 4000); policy_name: str (same pattern as Task 6); context_scope: str (pattern ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$)`.
  - `POST /ask` → `{"answer": str, "rule_id": str, "context_used": list[str]}`; `PolicyRefused` → 403 `detail`; `ContextLocked` → 409; `ContextUnavailable` → 503; `NoModelBackend` → 503 `detail="no model backend configured"`. Origin check: refuse when `Origin` is present and not `config.holder_origin`, where `AgentConfig.holder_origin: str` defaults to the first entry of `cors_origins` (the user app) and is documented as such; no new env var.

- [ ] **Step 1: Write the failing tests**

`test_config_env.py`: `test_backend_none_is_accepted_and_has_no_url`; `test_backend_env_error_names_none`.

`test_agent.py` (rewrite): with `FakeVault` as the client and a `FakeBackend` returning fixed text: `test_ask_refuses_identity_domain_before_reading` (vault records no reads), `test_ask_refuses_root_identity_key`, `test_ask_denies_without_matching_rule`, `test_ask_answers_under_a_matching_rule_with_entries_in_scope` (`context_used == ["personal/age"]`, prompt contains the field), `test_ask_requires_unlocked_vault` (`ContextLocked` propagates), `test_ask_without_backend_raises_no_model_backend`, `test_ask_under_seeded_policy_passes_as_holder` (the rule requires ephemeral identity; the holder is allowed).

`test_api_ask.py`: `test_ask_route_returns_answer_and_rule`, `test_ask_route_403_on_identity_scope`, `test_ask_route_503_without_backend`, `test_ask_route_refuses_business_origin` (Origin `https://localhost:4502` → 403), `test_ask_route_409_when_locked`.

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**, **Step 4: Run full agent suite and lint**

Run: `cd agent && uv run pytest -q && cd .. && uv run ruff check agent spec && uv run ruff format --check agent spec`
Expected: PASS, all green.

- [ ] **Step 5: Update `agent/README.md`**

Sections: "Where policies come from" (vault, `policies/{name}`, the three refusals), "Two decision paths" (what each asserts, why autonomous cannot satisfy ephemeral identity), "Reasons" (generic vs holder-facing), "Ask" (route, refusals, `FREEHOLD_LLM_BACKEND=none`). Replace the `Agent().process` quick-start snippet with `ask`. Environment-variables table: add `none` to the backend row.

- [ ] **Step 6: Commit**

```bash
git add agent/src/freehold_agent/config.py agent/src/freehold_agent/agent.py agent/src/freehold_agent/api.py agent/src/freehold_agent/errors.py agent/tests/test_config_env.py agent/tests/test_agent.py agent/tests/test_api_ask.py agent/README.md
git commit -m "Let the holder ask their agent about their own data, under a policy, never about identity" -m "Part of #134"
```

### Task 9: User app: spec-shaped policies, seed, terms, Ask

**Files:**
- Modify: `demo/apps/user-app/src/types.ts` (replace the policy types; `VerificationRequest.policy_id` → `terms_hash: string`)
- Create: `demo/apps/user-app/src/policies.ts`
- Modify: `demo/apps/user-app/src/App.tsx` (unlock, reset, service request, approve, Policies tab, Ask box)
- Modify: `demo/apps/user-app/src/authorizations.ts` (`policyHash` in the record context; `policyId` out of metadata)
- Test: `demo/apps/user-app/src/policies.test.ts`

**Interfaces:**
- Consumes: `exportTerms`, `termsHash` from `@freehold-earth/identity` (Task 3); `ContextStoreClient` `listKeys`/`get`/`put`/`delete`.
- Produces, in `policies.ts`:
  - `export const POLICY_KEY_PREFIX = "policies/"`
  - `export type SPALPolicy` mirroring schema 1.0 (`version: "1.0"`, `id`, `name`, `description?`, `owner`, `rules: Array<{ id: string; context_scope: string; conditions: Conditions }>`, `enforcement?`, `created?`, `updated?`, `signature?`), `Conditions` with the five optional condition shapes from the schema.
  - `export function seedPolicy(rootDid: string, now: string): SPALPolicy` returning the age-verification policy: id `spal:${rootDid}:age-verification`, name "Age Verification Only", one rule `rule-age` on `personal/age` with `identity: {type: "ephemeral_required"}`, `proofs: [{type: "zkp", claim: "age"}]`, `retention: {max_seconds: 0, audit_log: true}`, `derivatives` all `forbidden`. Keep it byte-equal in meaning to `SEED_POLICY` in `agent/tests/fakes.py` (same rule content; `owner`/`id`/timestamps differ).
  - `export async function listPolicies(store): Promise<Array<{ key: string; policy: SPALPolicy; termsHash: string }>>`
  - `export async function ensureSeedPolicy(store, rootDid: string): Promise<void>` (seed only when no `policies/` key exists)
  - `export async function deletePolicies(store): Promise<void>`
  - `export function policyKeyName(policy: SPALPolicy): string` (segment after the last colon of `id`).

- [ ] **Step 1: Write the failing tests (`policies.test.ts`, with an in-memory fake store object implementing `listKeys/get/put/delete`)**

`seedPolicy embeds the root DID in id and owner`, `ensureSeedPolicy writes once`, `listPolicies returns terms hashes that match exportTerms`, `deletePolicies removes only the policies prefix`, `seed terms hash equals the agent's SEED_POLICY vector` (add the seed's `terms_hash` to `spec/schemas/spal/v1.0/terms-vectors.json` as a fourth vector named `demo-seed`, with a placeholder owner; Task 2's test then pins the Python side too).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter user-app test`
Expected: FAIL.

- [ ] **Step 3: Implement `policies.ts`, then wire `App.tsx`**

- `handleUnlock`: after `setRootIdentity(identity)`, `await ensureSeedPolicy(store, identity.did)` then load `listPolicies` into state (replaces `initialPolicies`).
- `handleResetVault`: `await deletePolicies(store)`.
- `handleRequestService`: body gains `policy_name: policyKeyName(selectedPolicy)`; one policy today, so the first listed.
- `issueEphemeralDid`: context gains `policyHash: <terms hash of the policy the request names>`, found by matching `request.terms_hash` against the listed policies; `policyId` leaves metadata.
- `handleApprove`: on 403, show `detail` (already rendered by `apiErrorMessage`); a 403 already undoes the record.
- `PoliciesTab`: render from the spec shape: name, description, each rule's scope and conditions, the terms hash in a `<code>`.
- Ask box on the context tab: question input, policy select (listed policies), scope select from the holder's scopes (`personal/*` keys only; the identity domain never appears), `POST /ask`, show answer and rule id; on 503 `no model backend configured`, show that text.

- [ ] **Step 4: Lint, typecheck, test, build**

Run: `pnpm --filter user-app lint && pnpm --filter user-app test && pnpm --filter user-app build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add demo/apps/user-app spec/schemas/spal/v1.0/terms-vectors.json agent/tests/fakes.py
git commit -m "User app keeps spec-shaped policies in the vault and asks the agent under them" -m "Part of #134"
```

### Task 10: Business app: terms in, hash out, direct mode gone

**Files:**
- Modify: `demo/apps/business-app/src/types.ts` (`VerificationRequest.terms_hash`; `ServiceRequest.terms`, `terms_hash`, `policy_label`)
- Modify: `demo/apps/business-app/src/App.tsx`
- Create: `demo/apps/business-app/src/terms.ts` (`describeTerms(terms): string[]`, one plain-English line per rule condition for display)
- Test: `demo/apps/business-app/src/terms.test.ts`
- Modify: `demo/docker-compose.yml` (drop the commented `VITE_ENABLE_SERVICE_FLOW` lines)

**Interfaces:**
- Consumes: service request fields from Task 6; `POST /requests` body from Task 7.

- [ ] **Step 1: Write the failing test**: `describeTerms` renders the seed policy's rule as lines containing "ephemeral", "zero retention" (or "no retention"), "no training".

- [ ] **Step 2: Implement**: `handleNewServiceRequests` sends `terms_hash: request.terms_hash`; the incoming card shows `policy_label.name` and `describeTerms(request.terms)` before the verification is created; the history card shows `response.terms_hash` as the echoed acceptance. Remove `SERVICE_FLOW_ENABLED`, `handleCreateVerification` and the direct-mode UI; remove the flag from the user app too (it is the same flag) and its compose comments.

- [ ] **Step 3: Lint, test, build both apps**

Run: `pnpm --filter business-app lint && pnpm --filter business-app test && pnpm --filter business-app build && pnpm --filter user-app lint && pnpm --filter user-app build`

- [ ] **Step 4: Commit**

```bash
git add demo/apps/business-app demo/apps/user-app demo/docker-compose.yml
git commit -m "Business app shows the holder's terms and echoes the hash it accepted" -m "Part of #134"
```

### Task 11: Demo compose, demo README, appendix

**Files:**
- Modify: `demo/docker-compose.yml` (agent env: `FREEHOLD_LLM_BACKEND=none`)
- Modify: `demo/README.md`
- Modify: `docs/architecture/technical-appendix.md` (reference policy: `payment` under `conditions`; `persona` marked proposed with a pointer to #135)
- Modify: `docs/superpowers/specs/2026-11-07-policies-in-the-context-store-design.md` (status line: implemented in PR)

- [ ] **Step 1: Compose**: add `- FREEHOLD_LLM_BACKEND=none` with a comment pointing at #70.

- [ ] **Step 2: Demo README**: Request Flow diagram gains `policy_name` on the service request, `terms`/`terms_hash` to the business, `terms_hash` on the verification request and in the response; Walkthrough step 1 names the seeded policy and its key; step 2 says the policy is checked on approve and what a 403 shows; a new "Ask your agent" step says what happens without a backend; remove the direct-mode paragraph.

- [ ] **Step 3: Appendix**: move `payment` into `conditions` in the reference policy; add one sentence before the example: "`persona` is a proposed field (#135); the agent refuses it until it is specified."

- [ ] **Step 4: Verify the example loads**: `cd agent && uv run python -c "import json,re; ..."` is not enough because of `persona`; instead assert in a one-off that the example minus `persona` validates with `SPALPolicy.model_validate`. Record the command and result in the commit body.

- [ ] **Step 5: Full workspace checks**

Run: `uv run ruff check agent spec && uv run ruff format --check agent spec && (cd agent && uv run pytest -q) && (cd spec && uv run pytest -q && uv run ty check .) && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add demo/docker-compose.yml demo/README.md docs/architecture/technical-appendix.md docs/superpowers/specs/2026-11-07-policies-in-the-context-store-design.md docs/superpowers/plans/2026-11-07-policies-in-the-context-store.md
git commit -m "Demo runs the policy path end to end; the appendix example loads again" -m "Part of #134"
```

---

## Self-review notes

- Spec coverage: §1 Task 4; §2 Tasks 1 to 3; §2a documented in Task 1's protocol doc, code in #16/#136; §3 Tasks 6, 7, 9, 10; §4 Task 4; §5 Task 5 and 7; §6 Task 8; §7 Task 9; §8 Task 10; §9 Tasks 1, 8, 11.
- Type consistency: `terms_hash` (snake) on the wire and in Python; `termsHash` in TypeScript; `Requester`, `PolicyRefused`, `GENERIC_DENIAL`, `policy_named`, `policy_for_terms`, `check(policy, scope, ctx, requester)` used identically in Tasks 4, 5, 7, 8.
- Known seam: Task 7's approve-with-DID test needs a real `ApprovalService` with a fake ZKP; the `StubService` pattern no longer covers the gate.
