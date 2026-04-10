# Shared — Espaço Compartilhado entre Agentes

## Estrutura

```
shared/
├── context/           ← Dados acessíveis por TODOS os agentes
│   ├── clients.md     ← Informações de clientes da Climoo
│   └── glossary.md    ← Vocabulário técnico padrão
├── handoffs/          ← Comunicação entre agentes
│   └── [origem]-to-[destino].md
└── README.md          ← Este arquivo
```

## Regras

1. **context/** — Qualquer agente pode ler. Só escreve quem tem contexto relevante.
2. **handoffs/** — Formato padrão para pedidos entre agentes:
   ```markdown
   ## Pedido: [título]
   - **De:** [agente origem]
   - **Para:** [agente destino]
   - **Data:** YYYY-MM-DD
   - **Contexto:** [o que precisa e por quê]
   - **Prazo:** YYYY-MM-DD
   - **Status:** pendente | em andamento | concluído
   ```
3. Handoffs concluídos devem ser movidos ou arquivados periodicamente.
