#!/usr/bin/env python3
"""Helpers simples para carregar variaveis de ambiente do arquivo .env."""

from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(dotenv_path: Path) -> None:
    """Carrega pares CHAVE=valor em os.environ sem sobrescrever o ambiente atual."""
    if not dotenv_path.exists():
        return

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if not key:
            continue

        if value and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]

        os.environ.setdefault(key, value)
