# SPDX-License-Identifier: EUPL-1.2
"""Bech32 (BIP 173), as age uses it for keys: age1… and AGE-SECRET-KEY-1…. age lifts the 90-character limit."""
from __future__ import annotations

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GENERATOR = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]


def _polymod(values: list[int]) -> int:
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= GENERATOR[i] if (top >> i) & 1 else 0
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convert(data: bytes | list[int], from_bits: int, to_bits: int, pad: bool) -> list[int]:
    acc = bits = 0
    out = []
    maxv = (1 << to_bits) - 1
    for value in data:
        if value < 0 or value >> from_bits:
            raise ValueError("invalid bech32 data")
        acc = (acc << from_bits) | value
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            out.append((acc >> bits) & maxv)
    if pad:
        if bits:
            out.append((acc << (to_bits - bits)) & maxv)
    elif bits >= from_bits or ((acc << (to_bits - bits)) & maxv):
        raise ValueError("invalid bech32 padding")
    return out


def encode(hrp: str, data: bytes) -> str:
    values = _convert(data, 8, 5, True)
    checksum_input = _hrp_expand(hrp) + values + [0] * 6
    polymod = _polymod(checksum_input) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[v] for v in values + checksum)


def decode(text: str) -> tuple[str, bytes]:
    if text.lower() != text and text.upper() != text:
        raise ValueError("mixed case in bech32 string")
    text = text.lower()
    pos = text.rfind("1")
    if pos < 1 or pos + 7 > len(text):
        raise ValueError("invalid bech32 string")
    hrp, rest = text[:pos], text[pos + 1 :]
    if any(c not in CHARSET for c in rest) or any(ord(c) < 33 or ord(c) > 126 for c in hrp):
        raise ValueError("invalid bech32 character")
    values = [CHARSET.index(c) for c in rest]
    if _polymod(_hrp_expand(hrp) + values) != 1:
        raise ValueError("invalid bech32 checksum")
    return hrp, bytes(_convert(values[:-6], 5, 8, False))
