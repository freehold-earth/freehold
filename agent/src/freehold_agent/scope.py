"""What a scope is, and what is in it.

A scope is a path such as ``personal/age``. It names what a policy rule
governs, and it is also the key the governed entry is stored under. This
module has no dependencies, so every layer can share one rule for what a
scope is and what lies in it.
"""

from __future__ import annotations

import re

SCOPE_PATTERN = r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$"
"""A scope as a clean path: segments of safe characters joined by single slashes."""
_SCOPE = re.compile(SCOPE_PATTERN)


def is_scope(scope: str | None) -> bool:
    """Whether ``scope`` is a clean path; a leading, trailing or doubled slash is not."""
    return bool(scope) and _SCOPE.fullmatch(scope) is not None


def is_key(key: str | None) -> bool:
    """Whether ``key`` is a clean path for storage: segments joined by single slashes, none empty.

    Looser than :func:`is_scope`: a policy's key is ``policies/{name}`` and a
    name may hold spaces or dots; what no key may hold is a leading,
    trailing or doubled slash, which would make it a different path from
    the one it was checked as.
    """
    return bool(key) and all(segment for segment in key.split("/"))


def in_scope(key: str, scope: str | None) -> bool:
    """Whether an entry key is in a scope: the scope itself, or anything under ``scope/``.

    A scope that is not a clean path (see :func:`is_scope`) admits no key.
    A key beside the scope (``personal/name`` for ``personal/age``) or
    merely prefixed by it (``personality``) is not in it.
    """
    if not is_scope(scope):
        return False
    return key == scope or key.startswith(scope + "/")
