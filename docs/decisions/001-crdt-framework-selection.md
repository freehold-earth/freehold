# ADR-001: CRDT Framework Selection

**Status:** Accepted
**Date:** 2025-12-10
**Decision:** Use Yjs for CRDT-based sync, with Jazz as future consideration

## Context

PCI Context Store (Layer 1) requires CRDT-based synchronization for conflict-free replication across user devices. We evaluated several frameworks:

| Framework | Weekly Downloads | GitHub Stars | Age | Cloud Dependency |
|-----------|-----------------|--------------|-----|------------------|
| Yjs | 1,893,211 | 20,700 | 11 years | None |
| Automerge | 32,123 | 5,800 | 8 years | None |
| Loro | 14,412 | 5,100 | 2 years | None |
| Jazz | 4,225 | 2,300 | 2 years | Optional |

## Decision

**Use Yjs** as the CRDT framework for PCI Context Store.

### Rationale

1. **Battle-tested at scale** - 1.9M weekly downloads, used by Affine, GitBook, Linear, JupyterLab
2. **No cloud dependency** - Fully self-hostable with multiple storage backends (PostgreSQL, MongoDB, IndexedDB)
3. **Mature ecosystem** - 11 years of development, extensive documentation, professional support available
4. **Network agnostic** - Works with WebSocket, WebRTC, or custom transports
5. **Performance** - Described as "the fastest CRDT implementation by far"

### Why Not Jazz?

Jazz offers attractive higher-level APIs (built-in auth, permissions, TypeScript-first), but:
- Only 2 years old with 450x fewer downloads than Yjs
- Hacker News feedback (Oct 2024): "not sure they realize how much more work they have to go"
- API still evolving rapidly
- Smaller community means fewer battle-tested edge cases

### Future Consideration

If Jazz matures significantly over 2-3 years (API stabilizes, adoption grows 10x+, production track record established), reconsider for its better developer experience.

## Consequences

### Positive
- Rock-solid sync infrastructure
- Large community for troubleshooting
- Multiple self-hosted backend options
- No vendor lock-in

### Negative
- Lower-level API requires more implementation work
- Must build auth/permissions layer ourselves
- No built-in encryption (we handle via AES-256-GCM)

## Implementation

1. Replace `jazz-tools` with `yjs` in pci-context-store dependencies
2. Wrap vault data in Y.Doc for CRDT operations
3. Add `y-indexeddb` for browser persistence
4. Add `y-websocket` for device sync (self-hosted)

## References

- [Yjs Documentation](https://docs.yjs.dev)
- [Yjs GitHub](https://github.com/yjs/yjs)
- [Full comparison analysis](/mnt/s/src/pci/plans/crdt-and-vector-storage-comparison.md)
