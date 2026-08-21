#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

CURRENT_STEP="initialization"

on_error() {
    local exit_code=$?
    local line_number="${1:-unknown}"
    printf '\n'
    printf '%s\n' '============================================================'
    printf '[FAILED] Update stopped during: %s\n' "$CURRENT_STEP"
    printf '[FAILED] Exit code: %s, script line: %s\n' "$exit_code" "$line_number"
    printf '%s\n' '============================================================'
    exit "$exit_code"
}

trap 'on_error "$LINENO"' ERR

check_command() {
    local command_name="$1"
    local display_name="$2"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        printf '[ERROR] Required command not found: %s (%s)\n' "$display_name" "$command_name" >&2
        printf '[ERROR] Install it and ensure it is available in PATH.\n' >&2
        return 1
    fi

    printf '[OK] Found %s: %s\n' "$display_name" "$(command -v "$command_name")"
}

printf '%s\n' '============================================================'
printf '%s\n' '         VCPToolBox Linux Server Global Updater'
printf '%s\n' '============================================================'
printf 'Repository: %s\n\n' "$SCRIPT_DIR"

CURRENT_STEP="checking required commands"
check_command git "Git"
check_command node "Node.js"
check_command npm "npm"
check_command cargo "Rust Cargo"
check_command rustc "Rust compiler"

if [[ ! -d .git ]] || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '[ERROR] This script is not running inside a Git repository.\n' >&2
    exit 1
fi

CURRENT_STEP="pulling latest source code"
printf '\n[1/6] Pulling latest source code with fast-forward only...\n'
git pull --ff-only
printf '[OK] Source code updated.\n'

CURRENT_STEP="installing root Node.js dependencies"
printf '\n[2/6] Installing/updating root Node.js dependencies...\n'
npm install --no-audit --no-fund
printf '[OK] Root Node.js dependencies updated.\n'

CURRENT_STEP="installing Vexus build dependencies"
printf '\n[3/6] Installing/updating Vexus build dependencies...\n'
if [[ ! -d rust-vexus-lite ]]; then
    printf '[ERROR] Directory not found: rust-vexus-lite\n' >&2
    exit 1
fi
npm --prefix rust-vexus-lite install --no-audit --no-fund
printf '[OK] Vexus build dependencies updated.\n'

CURRENT_STEP="building Rust Vexus vector database module"
printf '\n[4/6] Building Rust Vexus vector database module...\n'
npm --prefix rust-vexus-lite run build
printf '[OK] Rust Vexus module built.\n'

CURRENT_STEP="building DailyNoteSearcher Rust module"
printf '\n[5/6] Building DailyNoteSearcher Rust module...\n'
npm run build:daily-note-searcher
printf '[OK] DailyNoteSearcher built and deployed.\n'

CURRENT_STEP="building CodeSearcher Rust module"
printf '\n[6/6] Building CodeSearcher Rust module...\n'
npm run build:code-searcher
printf '[OK] CodeSearcher built and deployed.\n'

CURRENT_STEP="completed"
printf '\n%s\n' '============================================================'
printf '%s\n' '[SUCCESS] VCPToolBox Linux server update completed.'
printf '%s\n' 'Restart the managed service when your deployment policy allows.'
printf '%s\n' '============================================================'