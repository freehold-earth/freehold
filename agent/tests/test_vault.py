import json

import pytest

from freehold_agent.vault import VaultDecryptError, decrypt_entry, encrypt_entry

# Written by context-store/src/crypto (encryptWithPassword) with the password
# below; proves the agent reads what the TypeScript side writes.
TS_SAMPLE = (
    '{"ciphertext":"uy7uLSkUNoCEL1X06L7ckvDQ5DkFsJB7AYj8Tn09HzwEUHk8OhqyTtrG6+pYt85uYBA=",'
    '"iv":"acCO1CYKPMBUsN9w","authTag":"+cznX43szi6WAtpRF8Nd9w==",'
    '"salt":"WYX3m4Xl2W7dJHjVJQnLzWxjXjpDAYEbF09UHWxb48c="}'
)
PASSWORD = "correct horse battery staple"  # pragma: allowlist secret


def test_decrypts_what_the_typescript_library_wrote() -> None:
    assert json.loads(decrypt_entry(TS_SAMPLE, PASSWORD)) == {
        "birthDate": "1990-05-15",
        "fullName": "Alice Demo",
    }


def test_round_trip_in_the_shared_format() -> None:
    sealed = encrypt_entry('{"a": 1}', PASSWORD)
    fields = json.loads(sealed)
    assert set(fields) == {"ciphertext", "iv", "authTag", "salt"}
    assert decrypt_entry(sealed, PASSWORD) == '{"a": 1}'


def test_wrong_password_is_rejected() -> None:
    with pytest.raises(VaultDecryptError, match="wrong password"):
        decrypt_entry(TS_SAMPLE, "not the password")


@pytest.mark.parametrize(
    ("serialized", "message"),
    [
        ("not json", "not in the vault format"),
        ("[1, 2]", "not a vault object"),
        ('{"ciphertext": "AAAA"}', "not in the vault format"),
        ('{"ciphertext": "!!", "iv": "", "authTag": "", "salt": ""}', "not in the vault format"),
    ],
)
def test_malformed_entries_are_rejected(serialized: str, message: str) -> None:
    with pytest.raises(VaultDecryptError, match=message):
        decrypt_entry(serialized, PASSWORD)
