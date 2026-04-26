#!/bin/bash
#
# Switch agent model profiles for pi agents
# Usage: ./switch-models.sh [openai|opencode|copilot|current]
#

set -e

AGENTS_DIR="${HOME}/.pi/agent/gents"

# Show usage
usage() {
    echo "Usage: $(basename "$0") <profile>"
    echo ""
    echo "Profiles:"
    echo "  openai   - Use OpenAI models (gpt-5.4, gpt-4.1)"
    echo "  opencode - Use OpenCode Go models (mimo-v2-pro, mimo-v2-omni, minimax-m2.7)"
    echo "  copilot  - Use GitHub Copilot models (claude-sonnet-4.6, claude-haiku-4.5)"
    echo "  current  - Show current model assignments"
    echo ""
}

# Update model for a specific agent
update_agent_model() {
    local agent="$1"
    local model="$2"
    local file="${AGENTS_DIR}/${agent}.md"

    if [[ ! -f "$file" ]]; then
        echo "Warning: Agent file not found: $file" >&2
        return 1
    fi

    # Update the model line in frontmatter (macOS compatible, using | as delimiter)
    sed -i '' -E "s|^model:[[:space:]]*.+$|model: ${model}|" "$file"
    echo "  ✓ ${agent}: ${model}"
}

# Apply OpenAI profile
apply_openai() {
    echo "Switching to OpenAI profile..."
    update_agent_model "planner" "openai-codex/gpt-5.5"
    update_agent_model "scout" "openai-codex/gpt-5.3"
    update_agent_model "worker" "openai-codex/gpt-5.5"
    update_agent_model "reviewer" "openai-codex/gpt-5.5"
    update_agent_model "visual-tester" "openai-codex/gpt-5.5"
}

# Apply OpenCode Go profile
apply_opencode() {
    echo "Switching to OpenCode Go profile..."
    update_agent_model "planner" "opencode-go/kimi-k2.6"
    update_agent_model "scout" "opencode-go/glm-4.5-air"
    update_agent_model "worker" "opencode-go/glm-5.1"
    update_agent_model "reviewer" "opencode-go/kimi-k2.6"
    update_agent_model "visual-tester" "opencode-go/glm-5.1"
}

# Apply GitHub Copilot profile
apply_copilot() {
    echo "Switching to GitHub Copilot profile..."
    update_agent_model "planner" "github-copilot/claude-sonnet-4.6"
    update_agent_model "scout" "github-copilot/claude-haiku-4.5"
    update_agent_model "worker" "github-copilot/claude-sonnet-4.6"
    update_agent_model "reviewer" "github-copilot/claude-sonnet-4.6"
    update_agent_model "visual-tester" "github-copilot/claude-sonnet-4.6"
}

# Show current models
show_current() {
    echo "Current agent models:"
    echo "===================="
    for agent in planner scout worker reviewer visual-tester; do
        local file="${AGENTS_DIR}/${agent}.md"
        if [[ -f "$file" ]]; then
            local model
            model=$(grep "^model:" "$file" | head -1 | sed 's/model: //' | tr -d ' ')
            printf "  %-15s %s\n" "${agent}:" "$model"
        fi
    done
}

# Main
main() {
    local profile="${1:-}"

    # Check agents directory exists
    if [[ ! -d "$AGENTS_DIR" ]]; then
        echo "Error: Agents directory not found: $AGENTS_DIR" >&2
        exit 1
    fi

    # Handle no args or help
    if [[ -z "$profile" || "$profile" == "-h" || "$profile" == "--help" ]]; then
        usage
        exit 0
    fi

    # Handle current/show
    if [[ "$profile" == "current" || "$profile" == "show" ]]; then
        show_current
        exit 0
    fi

    # Apply profile
    case "$profile" in
        openai)
            apply_openai
            ;;
        opencode)
            apply_opencode
            ;;
        copilot)
            apply_copilot
            ;;
        *)
            echo "Error: Unknown profile '$profile'" >&2
            usage
            exit 1
            ;;
    esac

    echo ""
    echo "Done! Run '$(basename "$0") current' to verify."
}

main "$@"
