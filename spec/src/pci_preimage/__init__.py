"""Reference implementation of the PCI canonical preimage encoding.

The encoding is specified in ``protocols/preimage-encoding.md`` and guarantees
injectivity: no two distinct field tuples serialize to the same bytes. It is
deliberately hash-agnostic — this package produces the bytes that are hashed,
never a digest.
"""

__all__: list[str] = []
