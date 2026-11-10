# SPDX-License-Identifier: EUPL-1.2
"""age format: round trips, tampering, and interoperability with the reference `age` tool when it is installed."""
import os
import shutil
import subprocess

import pytest

from kluis import age, bech32

AGE = shutil.which("age")
KEYGEN = shutil.which("age-keygen")


def test_bech32_roundtrip_and_checksum():
    data = bytes(range(32))
    text = bech32.encode("age", data)
    assert text.startswith("age1") and bech32.decode(text) == ("age", data)
    broken = text[:-1] + ("q" if text[-1] != "q" else "p")
    with pytest.raises(ValueError):
        bech32.decode(broken)


@pytest.mark.parametrize("size", [0, 1, 65535, 65536, 65537, 3 * 65536, 200_000])
def test_roundtrip_recipients(size):
    a, b = age.Identity.generate(), age.Identity.generate()
    plain = os.urandom(size)
    data = age.encrypt(plain, recipients=[a.recipient, b.recipient])
    assert data.startswith(b"age-encryption.org/v1\n")
    assert age.decrypt(data, identities=[a]) == plain
    assert age.decrypt(data, identities=[b]) == plain
    assert age.recipients_of(data) == 2


def test_wrong_identity_and_tampering():
    a, other = age.Identity.generate(), age.Identity.generate()
    data = age.encrypt(b"geheim", recipients=[a.recipient])
    with pytest.raises(age.AgeError, match="no matching identity"):
        age.decrypt(data, identities=[other])
    header_end = data.index(b"\n---") + 1
    flipped_header = bytearray(data)
    flipped_header[header_end - 5] ^= 1  # inside the last body line of the stanza
    with pytest.raises(age.AgeError):
        age.decrypt(bytes(flipped_header), identities=[a])
    flipped_payload = bytearray(data)
    flipped_payload[-1] ^= 1
    with pytest.raises(age.AgeError, match="payload"):
        age.decrypt(bytes(flipped_payload), identities=[a])
    with pytest.raises(age.AgeError):
        age.decrypt(data[:-17], identities=[a])


def test_passphrase():
    data = age.encrypt(b"sleutel", passphrase="correct paard batterij niet", log_n=10)
    assert age.decrypt(data, passphrase="correct paard batterij niet") == b"sleutel"
    with pytest.raises(age.AgeError, match="wrong passphrase"):
        age.decrypt(data, passphrase="fout")
    with pytest.raises(age.AgeError):
        age.encrypt(b"x", recipients=[age.Identity.generate().recipient], passphrase="ook")


def test_identity_text_forms():
    i = age.Identity.generate()
    assert str(i).startswith("AGE-SECRET-KEY-1") and age.Identity.parse(str(i)) == i
    assert "AGE-SECRET" not in repr(i)
    text = i.identity_file("2026-11-10T00:00:00Z")
    assert age.identities_from_file(text) == [i]
    with pytest.raises(age.AgeError):
        age.parse_recipient(str(i))


@pytest.mark.skipif(not (AGE and KEYGEN), reason="age tool not installed")
def test_interop_with_age_tool(tmp_path):
    # Our key and our file, opened by age.
    mine = age.Identity.generate()
    (tmp_path / "mine.txt").write_text(mine.identity_file("2026-11-10T00:00:00Z"))
    public = subprocess.run([KEYGEN, "-y", str(tmp_path / "mine.txt")], capture_output=True, text=True, check=True).stdout.strip()
    assert public == mine.recipient
    plain = os.urandom(150_000)
    (tmp_path / "ours.age").write_bytes(age.encrypt(plain, recipients=[mine.recipient]))
    out = subprocess.run([AGE, "-d", "-i", str(tmp_path / "mine.txt"), str(tmp_path / "ours.age")], capture_output=True, check=True).stdout
    assert out == plain

    # A key and a file made by age, opened by us.
    subprocess.run([KEYGEN, "-o", str(tmp_path / "theirs.txt")], capture_output=True, check=True)
    theirs = age.identities_from_file((tmp_path / "theirs.txt").read_text())
    (tmp_path / "plain.bin").write_bytes(plain)
    subprocess.run([AGE, "-r", theirs[0].recipient, "-o", str(tmp_path / "theirs.age"), str(tmp_path / "plain.bin")], check=True)
    assert age.decrypt((tmp_path / "theirs.age").read_bytes(), identities=theirs) == plain
