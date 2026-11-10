# SPDX-License-Identifier: EUPL-1.2
"""The vault package does no networking: no module imports a network library."""
import ast
from pathlib import Path

FORBIDDEN = {"socket", "ssl", "http", "urllib", "requests", "httpx", "aiohttp", "smtplib", "ftplib", "js", "pyodide"}


def test_no_network_imports():
    src = Path(__file__).resolve().parents[1] / "src" / "kluis"
    for path in src.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                if name == "urllib.parse":  # string handling only (quote for mailto links)
                    continue
                assert name.split(".")[0] not in FORBIDDEN, f"{path.name} imports {name}"
