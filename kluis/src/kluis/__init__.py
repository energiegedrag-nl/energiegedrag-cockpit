# SPDX-License-Identifier: EUPL-1.2
"""Energiegedrag Cockpit, local vault: participant data, encrypted (age), only on the campaign manager's device.

Design: docs/kluis.md. This package runs in Pyodide in a Web Worker and in CPython (tests).
It does no networking: the page does the few requests there are (creating accounts, storing the encrypted vault),
and never with personal data. tests/test_kern.py checks that no module here imports a network library.
"""

__version__ = "0.1.0"
