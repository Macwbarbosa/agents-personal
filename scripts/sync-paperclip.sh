#!/usr/bin/env zsh
# sync-paperclip.sh
# Fonte da verdade: ~/.claude/agents/
# Paperclip é espelho — visualiza e edita, mas não controla existência.
#
# Regras:
#   - Agente na pasta raiz sem registro no Paperclip → cria via API + symlink
#   - Agente no Paperclip sem pasta raiz → move instruções para pasta raiz + symlink
#   - Agente excluído no Paperclip mas na pasta raiz → recria via API + symlink
#   - Pasta no Paperclip sem agente no DB → limpa

set -eo pipefail
setopt nullglob 2>/dev/null || true

AGENTS_DIR="$HOME/.claude/agents"
PAPERCLIP_BASE="$HOME/.paperclip/instances/default/companies"
API="http://127.0.0.1:3100/api"

get_title() {
    case "$1" in
        sr-bazinga)      echo "COO" ;;
        climoo-product)  echo "Product Manager" ;;
        *)               echo "Agent" ;;
    esac
}

# Silencioso se Paperclip não está rodando
curl -sf "$API/health" > /dev/null 2>&1 || exit 0

# Company ativa
COMPANY_ID="${1:-$(curl -sf "$API/companies" | python3 -c "
import sys, json
cc = [c for c in json.load(sys.stdin) if c['status'] == 'active']
if cc: print(cc[0]['id'])
" 2>/dev/null)}"
[[ -z "$COMPANY_ID" ]] && exit 0

COMPANY_AGENTS_DIR="$PAPERCLIP_BASE/$COMPANY_ID/agents"
mkdir -p "$COMPANY_AGENTS_DIR"

echo "📎 Company: $COMPANY_ID"

# Buscar estado atual do DB
DB_AGENTS=$(curl -sf "$API/companies/$COMPANY_ID/agents" 2>/dev/null || echo "[]")

# Helper: checar se agent_id existe no DB
in_db() { echo "$DB_AGENTS" | python3 -c "import sys,json; print('yes' if any(a['id']=='$1' for a in json.load(sys.stdin)) else 'no')" 2>/dev/null; }

# Helper: achar agent_id no DB pelo slug
find_in_db() { echo "$DB_AGENTS" | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    if a.get('urlKey')=='$1': print(a['id']); break
" 2>/dev/null; }

# ============================================================
# PASSO 1: Para cada agente na pasta raiz, garantir que existe
#          no DB do Paperclip E tem symlink correto
# ============================================================
echo ""
echo "🔍 Pasta raiz → Paperclip..."

for agent_dir in "$AGENTS_DIR"/*/; do
    [[ -d "$agent_dir" ]] || continue
    agent_name=$(basename "$agent_dir")
    slug=$(echo "$agent_name" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    real_path="${agent_dir%/}"

    # Garantir arquivos base do Paperclip
    [[ -f "$real_path/AGENTS.md" ]]    || echo "# Agent: $agent_name" > "$real_path/AGENTS.md"
    [[ -f "$real_path/SOUL.md" ]]      || echo "# Soul: $agent_name" > "$real_path/SOUL.md"
    [[ -f "$real_path/HEARTBEAT.md" ]] || echo "# Heartbeat" > "$real_path/HEARTBEAT.md"
    [[ -f "$real_path/TOOLS.md" ]]     || printf "# Tools\n\n(Your tools will go here.)\n" > "$real_path/TOOLS.md"

    # Verificar se já tem symlink válido + agente no DB
    linked_uuid=""
    for pd in "$COMPANY_AGENTS_DIR"/*/; do
        [[ -L "$pd/instructions" ]] || continue
        target=$(readlink "$pd/instructions" 2>/dev/null || true)
        if [[ "$target" == "$real_path" ]]; then
            uuid=$(basename "$pd")
            if [[ "$(in_db "$uuid")" == "yes" ]]; then
                linked_uuid="$uuid"
            else
                # Symlink existe mas agente não está no DB → limpar
                rm -rf "$pd"
            fi
            break
        fi
    done

    if [[ -n "$linked_uuid" ]]; then
        echo "  ✅ $agent_name"
        continue
    fi

    # Verificar se existe no DB (por slug) mas sem symlink
    existing_id=$(find_in_db "$slug")

    if [[ -z "$existing_id" ]]; then
        # Criar via API
        display_name=$(echo "$agent_name" | sed 's/-/ /g' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2))}1')
        title=$(get_title "$agent_name")
        existing_id=$(curl -sf -X POST "$API/companies/$COMPANY_ID/agents" \
            -H "Content-Type: application/json" \
            -d "{\"name\":\"$display_name\",\"title\":\"$title\",\"slug\":\"$slug\",\"adapterType\":\"claude_local\"}" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || true)
        [[ -z "$existing_id" ]] && { echo "  ❌ $agent_name → falha ao criar"; continue; }
        echo "  🆕 $agent_name → criado no Paperclip"
    fi

    # Criar diretório + symlink
    mkdir -p "$COMPANY_AGENTS_DIR/$existing_id"
    rm -rf "$COMPANY_AGENTS_DIR/$existing_id/instructions"
    ln -s "$real_path" "$COMPANY_AGENTS_DIR/$existing_id/instructions"
    echo "  🔗 $agent_name → linkado ($existing_id)"

    # Atualizar DB_AGENTS para próximas iterações
    DB_AGENTS=$(curl -sf "$API/companies/$COMPANY_ID/agents" 2>/dev/null || echo "[]")
done

# ============================================================
# PASSO 2: Para cada agente no Paperclip que não é symlink,
#          mover instruções para pasta raiz e criar symlink
# ============================================================
echo ""
echo "🔍 Paperclip → pasta raiz..."

for pd in "$COMPANY_AGENTS_DIR"/*/; do
    [[ -d "$pd" ]] || continue
    uuid=$(basename "$pd")
    instr="$pd/instructions"

    # Verificar se existe no DB
    if [[ "$(in_db "$uuid")" == "no" ]]; then
        rm -rf "$pd"
        echo "  🧹 $uuid → órfão removido"
        continue
    fi

    if [[ -L "$instr" ]]; then
        target=$(readlink "$instr")
        echo "  ✅ $(basename "$target")"
    elif [[ -d "$instr" ]]; then
        # Agente criado no Paperclip — mover para pasta raiz
        folder=$(echo "$DB_AGENTS" | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    if a['id']=='$uuid': print(a.get('urlKey') or a['name'].lower().replace(' ','-')); break
" 2>/dev/null || true)
        folder="${folder:-paperclip-$uuid}"
        target_dir="$AGENTS_DIR/$folder"

        if [[ -d "$target_dir" ]]; then
            rm -rf "$instr"
            ln -s "$target_dir" "$instr"
        else
            mv "$instr" "$target_dir"
            ln -s "$target_dir" "$instr"
        fi
        echo "  🔗 $folder → sincronizado"
    elif [[ ! -e "$instr" ]]; then
        # Sem pasta instructions — criar symlink se tiver na pasta raiz
        folder=$(echo "$DB_AGENTS" | python3 -c "
import sys,json
for a in json.load(sys.stdin):
    if a['id']=='$uuid': print(a.get('urlKey') or a['name'].lower().replace(' ','-')); break
" 2>/dev/null || true)
        if [[ -n "$folder" && -d "$AGENTS_DIR/$folder" ]]; then
            ln -s "$AGENTS_DIR/$folder" "$instr"
            echo "  🔗 $folder → linkado"
        fi
    fi
done

echo ""
echo "✅ Sync completo."
