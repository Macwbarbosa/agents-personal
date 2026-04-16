#!/usr/bin/env python3
"""
reply_suggest.py - Geração de sugestão de resposta de email via Claude API.

Recebe o conteúdo do email (assunto, remetente, corpo) e gera uma
sugestão de resposta profissional no tom do Mac.

Requer: ANTHROPIC_API_KEY no .env ou variável de ambiente.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from .env_loader import load_dotenv
except ImportError:
    from env_loader import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")


def get_client():
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("SDK anthropic não instalado. Rode: pip3 install anthropic")

    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY não configurada. "
            "Adicione no arquivo .env: ANTHROPIC_API_KEY=sk-ant-..."
        )
    return anthropic.Anthropic(api_key=api_key)


def suggest_reply(
    subject: str,
    sender: str,
    body: str,
    *,
    extra_context: str = "",
    language: str = "pt-BR",
) -> str:
    """Gera sugestão de resposta para um email.

    Returns:
        Texto da resposta sugerida (sem saudação/assinatura genérica).
    """
    client = get_client()

    system_prompt = (
        "Você é o assistente de email do Mac Wendell Barbosa da Silva, "
        "Analista de Sustentabilidade na Climoo. "
        "Gere uma resposta profissional, direta e cordial para o email abaixo. "
        "Use português brasileiro. Não inclua linha de assunto. "
        "Comece direto com a saudação (ex: 'Olá [nome],') e termine com "
        "'Atenciosamente,\\nMac Wendell'. "
        "Seja conciso — máximo 2-3 parágrafos curtos. "
        "Se o email for uma notificação automática ou não precisar de resposta, "
        "diga isso claramente em vez de gerar uma resposta forçada."
    )

    user_content = f"Assunto: {subject}\nDe: {sender}\n\n{body}"
    if extra_context:
        user_content += f"\n\n--- Contexto adicional ---\n{extra_context}"

    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )

    return message.content[0].text.strip()
