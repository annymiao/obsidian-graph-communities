#!/bin/sh

set -eu

if [ "$#" -ne 8 ]; then
	echo "usage: install-local.sh SOURCE INSTALL SKILLS VAULT CODEX NODE CONFIG BACKUP" >&2
	exit 2
fi

source_directory=$1
install_directory=$2
skills_directory=$3
vault_directory=$4
codex_executable=$5
node_executable=$6
config_file=$7
backup_file=$8
skill_target="$skills_directory/obsidian-knowledge"

if [ ! -f "$source_directory/dist/src/index.js" ]; then
	echo "MCP build output is missing." >&2
	exit 1
fi
if [ ! -d "$source_directory/node_modules" ]; then
	echo "MCP runtime dependencies are missing." >&2
	exit 1
fi
if [ ! -d "$vault_directory" ]; then
	echo "Vault directory does not exist." >&2
	exit 1
fi
if [ ! -x "$codex_executable" ] || [ ! -x "$node_executable" ]; then
	echo "Codex or Node executable is unavailable." >&2
	exit 1
fi
if [ -e "$install_directory" ] || [ -e "$skill_target" ]; then
	echo "Global MCP or Skill target already exists; refusing to overwrite it." >&2
	exit 1
fi
if [ -e "$backup_file" ]; then
	echo "Backup path already exists; refusing to overwrite it." >&2
	exit 1
fi

mkdir -p "$install_directory" "$skills_directory"
cp -R \
	"$source_directory/dist" \
	"$source_directory/node_modules" \
	"$source_directory/package.json" \
	"$source_directory/pnpm-lock.yaml" \
	"$install_directory/"
cp -R "$source_directory/skills/obsidian-knowledge" "$skill_target"
cp -p "$config_file" "$backup_file"

"$codex_executable" mcp add obsidian_knowledge \
	--env "OBSIDIAN_VAULT_PATH=$vault_directory" \
	-- "$node_executable" "$install_directory/dist/src/index.js"

echo "Installed obsidian_knowledge MCP and obsidian-knowledge Skill."
