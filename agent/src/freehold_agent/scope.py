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


def in_scope(key: str, scope: str | None) -> bool:
    """Whether an entry key is in a scope: the scope itself, or anything under ``scope/``.

    An empty or absent scope, or one of nothing but slashes, admits no key.
    A key beside the scope (``personal/name`` for ``personal/age``) or
    merely prefixed by it (``personality``) is not in it.
    """
    if not scope or not scope.strip("/"):
        return False
    return key == scope or key.startswith(scope + "/")
