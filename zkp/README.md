# Freehold ZKP

Layer 4: Zero-knowledge proofs via Midnight for Personal Context Infrastructure.

This project is built on the Midnight Network.

## Overview

Freehold ZKP provides:

- **Zero-Knowledge Proofs** - Prove facts without revealing data
- **Ephemeral Identities** - Single-use DIDs for unlinkable interactions
- **Selective Disclosure** - Share only what's necessary
- **Privacy Circuits** - Common Freehold proof patterns

## Structure

This is a pnpm workspace containing:

```
zkp/
├── contract/           # Compact contracts (Midnight)
│   └── src/
│       └── proofs.compact
├── sdk/                # TypeScript SDK
│   └── src/
│       └── proofs/
└── tests/              # Integration tests
```

## Installation

```bash
pnpm add @freehold-earth/zkp-sdk
```

## Quick Start

```typescript
import { AgeVerification, ProofGenerator } from "@freehold-earth/zkp-sdk";

// Create a proof generator
const generator = new ProofGenerator();

// Generate an age verification proof
const proof = await generator.generateAgeProof({
  birthDate: new Date("1990-01-01"),
  minAge: 18,
});

// The proof proves age >= 18 without revealing birth date
console.log(proof.publicSignals); // { ageOver: 18, verified: true }
console.log(proof.proof);         // ZK proof data
```

## Available Proofs

| Proof Type | What it proves | What stays private |
|------------|---------------|-------------------|
| `AgeVerification` | Age >= threshold | Exact birth date |
| `LocationProof` | In region/country | Exact coordinates |
| `CredentialProof` | Has valid credential | Credential details |
| `IncomeRange` | Income in range | Exact amount |

## Midnight Integration

### One on-chain runtime

Midnight's support matrix pairs Midnight.js 5.0.0 and compact-runtime 0.21.0
with `@midnightntwrk/onchain-runtime-v4` 4.0.0 and `@midnightntwrk/ledger-v9`
1.0.0, and Midnight.js pins both exactly. compact-runtime and the wallet SDK
accept any 4.x and 1.x, so a package manager that resolves them separately
installs a second copy beside the pinned one, and every circuit call then
fails with "expected instance of StateValue" (#111). The SDK depends on
both at those versions directly, which npm deduplicates onto; a pnpm workspace
that installs the SDK should carry both pins in its `pnpm-workspace.yaml`:

```yaml
overrides:
  "@midnightntwrk/onchain-runtime-v4": 4.0.0
  "@midnightntwrk/ledger-v9": 1.0.0
```

Re-check the matrix and the pins whenever Midnight.js, compact-runtime or the
wallet SDK moves.

### Two npm names

Midnight is moving its packages from the `@midnight-ntwrk` npm name to
`@midnightntwrk` (no hyphen), and says the old name will stop getting
updates once the move is done. We take each package from the new name where
it is published there. As of 2026-11-12 that is the wallet SDK, the ledger and
the on-chain runtime. Midnight.js, compact-runtime and compact-js exist only
under the old name, so they stay there for now. On each version bump, check
whether they have moved, and switch the dependency and the imports when they
have.

This package uses Midnight's Compact language for ZK circuits:

```compact
// contract/src/proofs.compact
export circuit proveAgeOver(
  @secret birthDate: Field,
  @public minAge: Field,
  @public currentDate: Field
) -> Bool {
  let age = (currentDate - birthDate) / 365;
  return age >= minAge;
}
```

## Sponsoring proof fees (DUST)

Every on-chain proof costs DUST, Midnight's fee resource, and the service
pays it from its own wallet. DUST cannot be transferred, so a business that
wants its customers' proofs to cost them nothing does not send any. It
registers its NIGHT for DUST generation with the service's DUST address as
the receiver, which is the designation path ADR-007 chose:

1. Read the service's DUST address from `GET /health` (`dust.address`), or
   from `ManagedWallet.dustAddress`. The same object reports the balance.
2. From a wallet that holds NIGHT, run `designateDust(sponsor, address)`.
   It registers the sponsor's unregistered NIGHT, signed with the sponsor's
   NIGHT key, and returns the transaction id, the registration fee and what
   each UTXO will generate. A first registration pays its own fee from the
   NIGHT's future DUST, so the sponsor needs no DUST of its own.
3. The service's balance rises as DUST generates. `deregisterDust(sponsor)`
   stops it; DUST already generated decays away.

A proof request made without capacity fails before any transaction is
built: the service answers `402` with the DUST address to sponsor, and the
SDK throws `DustCapacityError` carrying the same. A successful on-chain
proof reports what it cost as `dustFee` (specks, decimal string).

## Development

### Prerequisites

1. **Node.js 22+** and **pnpm**
2. **Docker** and **Docker Compose** (for local Midnight network)
3. **Compact Compiler** (Midnight's contract language)

### Install Compact Compiler

```bash
# Install the compact version manager
curl -fsSL https://docs.midnight.network/install | bash

# Install a specific version (must match pragma in .compact files)
compact update 0.36.0

# Verify installation
~/.compact/versions/0.36.0/x86_64-unknown-linux-musl/compactc.bin --version
```

The Makefile expects `compactc.bin` to be in `~/.compact/versions/0.36.0/x86_64-unknown-linux-musl/`.

### Makefile Commands

```bash
make help       # Show all available commands
make dev        # Start local Midnight network
make down       # Stop network and clean volumes
make status     # Check network health
make compile    # Compile Compact contracts
make build      # Build all packages
make test       # Run unit tests
make test-int   # Run integration tests (requires network)
make lint       # Type check all packages
make clean      # Clean build artifacts
```

### Manual Build and Test

```bash
# Install dependencies
pnpm install

# Compile Compact contract to TypeScript
make compile

# Build all packages
make build

# Run tests
make test
```

### Run the service

The service is served over TLS or not at all: proofs and the claims behind
them cross its link. `TLS_CERT_FILE` and `TLS_KEY_FILE` name its certificate
and key, and it refuses to start without them. The `infra/` stack's
`certs.sh` writes a CA and a certificate per service; clients trust the CA.

```bash
../infra/scripts/certs.sh certs zkp               # certs/ca.crt, certs/zkp.{key,crt}
TLS_CERT_FILE=certs/zkp.crt TLS_KEY_FILE=certs/zkp.key npx tsx sdk/src/server.ts
curl --cacert certs/ca.crt https://localhost:8084/health
```

`PORT` (default `8084`), `BIND_ADDRESS` (default `127.0.0.1`; a container sets
`0.0.0.0`) and the `MIDNIGHT_*` endpoints below are the other settings.

### Verify Midnight Network is Running

```bash
make status

# Or manually:
curl http://localhost:9944/health      # Node
curl http://localhost:6300/health      # Proof server
# Indexer GraphQL — /api/v4/graphql is canonical; v3 is a backwards-compat alias
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"{ __typename }"}' \
  http://localhost:8088/api/v4/graphql
```

## Related Packages

- [spec](https://github.com/freehold-earth/freehold/tree/main/spec) - S-PAL schema and protocols
- [context-store](https://github.com/freehold-earth/freehold/tree/main/context-store) - Layer 1: Context Store
- [freehold-agent](https://github.com/freehold-earth/freehold/tree/main/agent) - Layer 2: Personal Agent
- [contracts](https://github.com/freehold-earth/freehold/tree/main/contracts) - Layer 3: Smart Contracts
- [identity](https://github.com/freehold-earth/freehold/tree/main/identity) - Layer 5: Identity (DIDs)

## License

Apache 2.0
