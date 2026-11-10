# SPDX-License-Identifier: EUPL-1.2
"""The age file format, v1 (https://age-encryption.org/v1, C2SP spec), with X25519 and scrypt recipients.

Small on purpose: the vault depends on it, and anyone should be able to read it in one go and check it against the
spec. Files written here open with the standard `age` tool and vice versa (tests/test_age.py checks both ways when
`age` is installed; CI installs it).

    file key   16 random bytes
    header     "age-encryption.org/v1", one stanza per recipient (the file key wrapped for that recipient),
               "---" and an HMAC-SHA256 over the header made with a key derived from the file key
    payload    16-byte nonce, then ChaCha20-Poly1305 in chunks of 64 KiB (STREAM), key derived from file key + nonce

Only the `cryptography` package is used for the primitives (X25519, ChaCha20-Poly1305, HKDF, HMAC, scrypt).
"""
from __future__ import annotations

import base64
import hmac
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hmac import HMAC
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, PublicFormat, NoEncryption

from . import bech32

INTRO = b"age-encryption.org/v1\n"
CHUNK = 64 * 1024
TAG = 16
SCRYPT_LOG_N = 18  # the default of the age tool; about 256 MB and a second or two
MAX_SCRYPT_LOG_N = 22


class AgeError(Exception):
    """The file is not valid age, or no identity fits, or it was changed."""


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    if "=" in text or "\n" in text or "\r" in text:
        raise AgeError("invalid base64 in header")
    try:
        data = base64.b64decode(text + "=" * (-len(text) % 4), validate=True)
    except ValueError as e:
        raise AgeError("invalid base64 in header") from e
    if _b64(data) != text:  # non-canonical encoding
        raise AgeError("non-canonical base64 in header")
    return data


def _hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


def _seal(key: bytes, plaintext: bytes) -> bytes:
    return ChaCha20Poly1305(key).encrypt(b"\0" * 12, plaintext, None)


def _open(key: bytes, ciphertext: bytes) -> bytes:
    return ChaCha20Poly1305(key).decrypt(b"\0" * 12, ciphertext, None)


# ---- keys --------------------------------------------------------------------------------------------------------

def _raw_private(key: X25519PrivateKey) -> bytes:
    return key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())


def _raw_public(key: X25519PublicKey) -> bytes:
    return key.public_bytes(Encoding.Raw, PublicFormat.Raw)


@dataclass(frozen=True)
class Identity:
    """An X25519 identity: AGE-SECRET-KEY-1…"""

    secret: bytes

    @classmethod
    def generate(cls) -> "Identity":
        return cls(_raw_private(X25519PrivateKey.generate()))

    @classmethod
    def parse(cls, text: str) -> "Identity":
        hrp, data = bech32.decode(text.strip().lower())
        if hrp != "age-secret-key-" or len(data) != 32 or text.strip() != text.strip().upper():
            raise AgeError("not an age secret key (AGE-SECRET-KEY-1…)")
        return cls(data)

    def __str__(self) -> str:
        return bech32.encode("age-secret-key-", self.secret).upper()

    def __repr__(self) -> str:  # never print the secret by accident
        return f"Identity({self.recipient})"

    @property
    def recipient(self) -> str:
        public = _raw_public(X25519PrivateKey.from_private_bytes(self.secret).public_key())
        return bech32.encode("age", public)

    def identity_file(self, created: str) -> str:
        """The text of an identity file as `age-keygen` writes it."""
        return f"# created: {created}\n# public key: {self.recipient}\n{self}\n"


def parse_recipient(text: str) -> bytes:
    hrp, data = bech32.decode(text.strip())
    if hrp != "age" or len(data) != 32 or text.strip() != text.strip().lower():
        raise AgeError(f"not an age X25519 recipient (age1…): {text[:12]}…")
    return data


def identities_from_file(text: str) -> list[Identity]:
    out = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(Identity.parse(line))
    if not out:
        raise AgeError("no identity in the file")
    return out


# ---- stanzas -----------------------------------------------------------------------------------------------------

@dataclass
class Stanza:
    type: str
    args: list[str]
    body: bytes

    def encode(self) -> bytes:
        line = " ".join(["->", self.type, *self.args]) + "\n"
        text = _b64(self.body)
        lines = [text[i : i + 64] for i in range(0, len(text), 64)]
        if not lines or len(lines[-1]) == 64:
            lines.append("")  # the last body line is always shorter than 64 columns
        return (line + "\n".join(lines) + "\n").encode()


def _x25519_wrap(file_key: bytes, recipient: bytes) -> Stanza:
    ephemeral = X25519PrivateKey.generate()
    share = _raw_public(ephemeral.public_key())
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(recipient))
    if shared == b"\0" * 32:
        raise AgeError("invalid recipient")
    key = _hkdf(shared, share + recipient, b"age-encryption.org/v1/X25519")
    return Stanza("X25519", [_b64(share)], _seal(key, file_key))


def _x25519_unwrap(stanza: Stanza, identity: Identity) -> bytes | None:
    if len(stanza.args) != 1:
        raise AgeError("invalid X25519 stanza")
    share = _unb64(stanza.args[0])
    if len(share) != 32 or len(stanza.body) != 32:
        raise AgeError("invalid X25519 stanza")
    private = X25519PrivateKey.from_private_bytes(identity.secret)
    shared = private.exchange(X25519PublicKey.from_public_bytes(share))
    if shared == b"\0" * 32:
        raise AgeError("invalid X25519 share")
    recipient = _raw_public(private.public_key())
    key = _hkdf(shared, share + recipient, b"age-encryption.org/v1/X25519")
    try:
        return _open(key, stanza.body)
    except Exception:
        return None  # not for this identity


def _scrypt_key(passphrase: str, salt: bytes, log_n: int) -> bytes:
    return Scrypt(salt=b"age-encryption.org/v1/scrypt" + salt, length=32, n=2**log_n, r=8, p=1).derive(passphrase.encode())


def _scrypt_wrap(file_key: bytes, passphrase: str, log_n: int) -> Stanza:
    salt = os.urandom(16)
    return Stanza("scrypt", [_b64(salt), str(log_n)], _seal(_scrypt_key(passphrase, salt, log_n), file_key))


def _scrypt_unwrap(stanza: Stanza, passphrase: str) -> bytes | None:
    if len(stanza.args) != 2 or not stanza.args[1].isdigit() or stanza.args[1].startswith("0"):
        raise AgeError("invalid scrypt stanza")
    salt, log_n = _unb64(stanza.args[0]), int(stanza.args[1])
    if len(salt) != 16 or len(stanza.body) != 32:
        raise AgeError("invalid scrypt stanza")
    if log_n > MAX_SCRYPT_LOG_N:
        raise AgeError(f"scrypt work factor 2^{log_n} is too large")
    try:
        return _open(_scrypt_key(passphrase, salt, log_n), stanza.body)
    except Exception:
        return None  # wrong passphrase


# ---- header and payload ------------------------------------------------------------------------------------------

def _mac(file_key: bytes, header_without_mac: bytes) -> bytes:
    h = HMAC(_hkdf(file_key, b"", b"header"), hashes.SHA256())
    h.update(header_without_mac)
    return h.finalize()


def _parse_header(data: bytes) -> tuple[list[Stanza], bytes, bytes, int]:
    """Stanzas, the header bytes covered by the MAC, the MAC, and where the payload starts."""
    if not data.startswith(INTRO):
        raise AgeError("not an age file (no age-encryption.org/v1 line)")
    pos = len(INTRO)
    stanzas: list[Stanza] = []
    while True:
        end = data.find(b"\n", pos)
        if end < 0:
            raise AgeError("truncated header")
        line = data[pos:end].decode("ascii", "strict")
        if line.startswith("--- "):
            mac = _unb64(line[4:])
            if len(mac) != 32:
                raise AgeError("invalid header MAC")
            return stanzas, data[: pos + 3], mac, end + 1
        parts = line.split(" ")
        if parts[0] != "->" or len(parts) < 2 or any(p == "" for p in parts):
            raise AgeError("invalid stanza line")
        pos = end + 1
        body_lines = []
        while True:
            end = data.find(b"\n", pos)
            if end < 0:
                raise AgeError("truncated stanza")
            body = data[pos:end].decode("ascii", "strict")
            pos = end + 1
            if len(body) > 64:
                raise AgeError("stanza body line too long")
            body_lines.append(body)
            if len(body) < 64:
                break
        stanzas.append(Stanza(parts[1], parts[2:], _unb64("".join(body_lines))))


def _nonce(counter: int, last: bool) -> bytes:
    return counter.to_bytes(11, "big") + (b"\x01" if last else b"\x00")


def encrypt(plaintext: bytes, recipients: list[str] | None = None, passphrase: str | None = None, log_n: int = SCRYPT_LOG_N) -> bytes:
    """Encrypt to X25519 recipients (age1…) or, exclusively, to a passphrase."""
    if bool(recipients) == bool(passphrase):
        raise AgeError("give either recipients or a passphrase (age allows scrypt only as the sole recipient)")
    file_key = os.urandom(16)
    if passphrase:
        stanzas = [_scrypt_wrap(file_key, passphrase, log_n)]
    else:
        stanzas = [_x25519_wrap(file_key, parse_recipient(r)) for r in dict.fromkeys(recipients or [])]
    header = INTRO + b"".join(s.encode() for s in stanzas) + b"---"
    header += b" " + _b64(_mac(file_key, header)).encode() + b"\n"

    nonce = os.urandom(16)
    aead = ChaCha20Poly1305(_hkdf(file_key, nonce, b"payload"))
    chunks = [plaintext[i : i + CHUNK] for i in range(0, len(plaintext), CHUNK)] or [b""]
    out = [header, nonce]
    for i, chunk in enumerate(chunks):
        out.append(aead.encrypt(_nonce(i, i == len(chunks) - 1), chunk, None))
    return b"".join(out)


def decrypt(data: bytes, identities: list[Identity] | None = None, passphrase: str | None = None) -> bytes:
    stanzas, header, mac, start = _parse_header(data)
    file_key = None
    if any(s.type == "scrypt" for s in stanzas):
        if len(stanzas) != 1:
            raise AgeError("a scrypt stanza must be the only one in the header")
        if passphrase is None:
            raise AgeError("this file is encrypted with a passphrase")
        file_key = _scrypt_unwrap(stanzas[0], passphrase)
        if file_key is None:
            raise AgeError("wrong passphrase")
    else:
        for stanza in stanzas:
            if stanza.type != "X25519":
                continue
            for identity in identities or []:
                file_key = _x25519_unwrap(stanza, identity)
                if file_key is not None:
                    break
            if file_key is not None:
                break
        if file_key is None:
            raise AgeError("no matching identity: this file was not encrypted for this key")
    if len(file_key) != 16 or not hmac.compare_digest(_mac(file_key, header), mac):
        raise AgeError("header MAC does not match: the file was changed")

    payload = data[start:]
    if len(payload) < 16 + TAG:
        raise AgeError("truncated payload")
    aead = ChaCha20Poly1305(_hkdf(file_key, payload[:16], b"payload"))
    body = payload[16:]
    out = []
    size = CHUNK + TAG
    count = max(1, -(-len(body) // size))
    for i in range(count):
        chunk = body[i * size : (i + 1) * size]
        last = i == count - 1
        try:
            plain = aead.decrypt(_nonce(i, last), chunk, None)
        except Exception as e:
            raise AgeError("payload does not authenticate: the file was changed or truncated") from e
        if last and not plain and i > 0:
            raise AgeError("empty last chunk")
        out.append(plain)
    return b"".join(out)


def recipients_of(data: bytes) -> int:
    """Number of recipient stanzas (without decrypting); for display."""
    return len(_parse_header(data)[0])
