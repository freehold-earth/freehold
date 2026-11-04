"""Client-side encryption of context-store entries.

The context store never sees plaintext or keys: whoever writes an entry
encrypts it first, and whoever reads it decrypts it. This module is the
Python side of the format the TypeScript library
(``context-store/src/crypto``) and the demo user app (``crypto.ts``) write,
so the agent can read what the user's apps stored.

Format: AES-256-GCM over the UTF-8 plaintext, with a key derived from the
password by PBKDF2-HMAC-SHA256 (100,000 iterations) over a fresh 32-byte
salt per entry, serialised as a JSON object of base64 fields:
``{"ciphertext", "iv", "authTag", "salt"}``. The IV is 12 bytes and the
tag 16; the tag is kept separate from the ciphertext in the serialised
form. A fresh salt per entry means every entry costs one key derivation to
read, which is the format's choice rather than this module's.
"""

from __future__ import annotations

import base64
import binascii
import json
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

KEY_LENGTH = 32
IV_LENGTH = 12
TAG_LENGTH = 16
SALT_LENGTH = 32
PBKDF2_ITERATIONS = 100_000


class VaultDecryptError(ValueError):
    """The entry could not be decrypted."""


class VaultFormatError(VaultDecryptError):
    """The entry is not in the vault format, so no password would open it."""


class VaultKeyError(VaultDecryptError):
    """The entry is in the vault format but the password does not open it."""


def derive_key(password: str, salt: bytes) -> bytes:
    """Derive the AES key for one entry from the password and that entry's salt."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=KEY_LENGTH, salt=salt, iterations=PBKDF2_ITERATIONS
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt_entry(plaintext: str, password: str) -> str:
    """Encrypt ``plaintext`` under ``password`` in the serialised vault format."""
    salt = os.urandom(SALT_LENGTH)
    iv = os.urandom(IV_LENGTH)
    sealed = AESGCM(derive_key(password, salt)).encrypt(iv, plaintext.encode("utf-8"), None)
    fields = {
        "ciphertext": sealed[:-TAG_LENGTH],
        "iv": iv,
        "authTag": sealed[-TAG_LENGTH:],
        "salt": salt,
    }
    return json.dumps({k: base64.b64encode(v).decode("ascii") for k, v in fields.items()})


def decrypt_entry(serialized: str, password: str) -> str:
    """Decrypt a serialised vault entry with ``password``.

    Raises:
        VaultFormatError: The entry is not in the vault format, for example
            one encrypted with a raw key (no salt) or not JSON at all.
        VaultKeyError: The password does not open it, or it is corrupt.
    """
    try:
        fields = json.loads(serialized)
    except ValueError as exc:
        raise VaultFormatError("entry is not in the vault format") from exc
    if not isinstance(fields, dict):
        raise VaultFormatError("entry is not a vault object")
    try:
        parts = {
            name: base64.b64decode(fields[name], validate=True)
            for name in ("ciphertext", "iv", "authTag", "salt")
        }
    except (ValueError, TypeError, KeyError, binascii.Error) as exc:
        raise VaultFormatError("entry is not in the vault format") from exc
    expected = {"iv": IV_LENGTH, "authTag": TAG_LENGTH, "salt": SALT_LENGTH}
    if any(len(parts[name]) != length for name, length in expected.items()):
        raise VaultFormatError("entry is not in the vault format")

    key = derive_key(password, parts["salt"])
    try:
        plaintext = AESGCM(key).decrypt(parts["iv"], parts["ciphertext"] + parts["authTag"], None)
        return plaintext.decode("utf-8")
    except (InvalidTag, ValueError) as exc:
        raise VaultKeyError("wrong password or corrupt entry") from exc
