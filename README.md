# Freehold

Personal Context Infrastructure: a layered architecture for data sovereignty. Your data stays local, policy is enforced cryptographically, and claims are verified with zero-knowledge proofs. Held freehold, not leasehold.

| Directory | What it is | Stack |
|---|---|---|
| [`docs/`](docs/) | Manifesto, architecture, ADRs | Markdown |
| [`spec/`](spec/) | S-PAL schema, protocol specs, OpenAPI, reference preimage encoder | Python (`pci-preimage`) |
| [`context-store/`](context-store/) | Layer 1: encrypted local-first storage | TypeScript |
| [`agent/`](agent/) | Layer 2: local AI agent and coordination service | Python (`pci-agent`) |
| [`contracts/`](contracts/) | Layer 3: S-PAL enforcement contracts | Aiken + TypeScript |
| [`zkp/`](zkp/) | Layer 4: Midnight zero-knowledge proof service | Compact + TypeScript |
| [`identity/`](identity/) | W3C DID implementation (did:key, ephemeral DIDs) | TypeScript |
| [`demo/`](demo/) | Interactive demo applications | TypeScript / React |
| [`infra/`](infra/) | Local orchestration for development and testing | Docker Compose |

## Development

```bash
pnpm install              # all TypeScript packages
uv sync --all-packages    # both Python packages
pnpm test                 # TypeScript test suites
(cd agent && uv run pytest) && (cd spec && uv run pytest)
```

Each directory keeps its own README with component-specific instructions. Release tags are `<component>-v<semver>`, for example `agent-v0.2.0`.

## License

Apache-2.0. See [LICENSE](LICENSE).
