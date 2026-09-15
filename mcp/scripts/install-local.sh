#!/bin/sh

set -eu
umask 077
COPYFILE_DISABLE=1
export COPYFILE_DISABLE

show_migration() {
	echo "usage: install-local.sh SOURCE INSTALL SKILLS PRIVATE_RUNTIME_ENV_JSON CODEX NODE CONFIG BACKUP" >&2
	echo "The v1.3 default never starts from a Vault path." >&2
	echo "First run: NODE SOURCE/dist/src/offlineCompile.js --once with explicit source/artifact settings." >&2
	echo "Then create a chmod-600 JSON object containing catalog, embedding, principal ACL, and review environment values." >&2
}

if [ "$#" -ne 8 ]; then
	show_migration
	exit 2
fi

source_directory=$1
install_directory=$2
skills_directory=$3
runtime_environment_file=$4
codex_executable=$5
node_executable=$6
config_file=$7
backup_file=$8
while [ "$install_directory" != "/" ] && [ "${install_directory%/}" != "$install_directory" ]; do
	install_directory=${install_directory%/}
done
while [ "$skills_directory" != "/" ] && [ "${skills_directory%/}" != "$skills_directory" ]; do
	skills_directory=${skills_directory%/}
done
skill_target="$skills_directory/obsidian-knowledge"
process_token=$$
install_stage="${install_directory}.install-${process_token}.stage"
skill_stage="${skill_target}.install-${process_token}.stage"
config_restore="${config_file}.install-${process_token}.restore"
lock_directory="${install_directory}.install.lock"
installed_moved=false
skill_moved=false
config_may_have_changed=false
completed=false

for protected_path in "$install_directory" "$skill_target" "$backup_file" "$runtime_environment_file"; do
	case "$protected_path" in
		''|/|.|..)
			echo "Install, Skill, backup, and runtime configuration paths must be explicit non-root paths." >&2
			exit 2
			;;
	esac
done

for required_file in \
	"$source_directory/dist/src/secondBrainMcp.js" \
	"$source_directory/dist/src/secondBrainHttp.js" \
	"$source_directory/dist/src/offlineCompile.js" \
	"$source_directory/dist/src/index.js" \
	"$source_directory/dist/src/http.js" \
	"$source_directory/package.json" \
	"$source_directory/pnpm-lock.yaml" \
	"$source_directory/scripts/smoke-client.mjs" \
	"$source_directory/scripts/test.mjs" \
	"$source_directory/scripts/upgrade-local.sh" \
	"$source_directory/skills/obsidian-knowledge/SKILL.md"; do
	if [ ! -f "$required_file" ]; then
		echo "The v1.3 MCP release is incomplete; refusing to install." >&2
		exit 1
	fi
done
if [ ! -d "$source_directory/node_modules" ]; then
	echo "MCP runtime dependencies are missing." >&2
	exit 1
fi
if [ ! -f "$runtime_environment_file" ] || [ -L "$runtime_environment_file" ]; then
	show_migration
	echo "Private runtime environment JSON must be a real regular file." >&2
	exit 1
fi
if [ ! -f "$config_file" ] || [ -L "$config_file" ]; then
	echo "Codex config must be a real regular file." >&2
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
for temporary_path in "$install_stage" "$skill_stage" "$config_restore"; do
	if [ -e "$temporary_path" ]; then
		echo "Install staging path already exists; refusing to continue." >&2
		exit 1
	fi
done

mkdir -p "$(dirname "$install_directory")" "$skills_directory" "$(dirname "$backup_file")"

# Resolve all public and private inputs before creating a backup or staging a
# release. The compiled catalog must live outside the release and destinations.
"$node_executable" --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const [source, install, skill, config, backup, runtimeEnv] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
const requiredEntries = {
  "obsidian-knowledge-mcp": "dist/src/secondBrainMcp.js",
  "obsidian-knowledge-gateway": "dist/src/secondBrainHttp.js",
  "obsidian-second-brain-compile": "dist/src/offlineCompile.js",
  "obsidian-knowledge-mcp-legacy": "dist/src/index.js",
  "obsidian-knowledge-gateway-legacy": "dist/src/http.js",
};
if (manifest.name !== "obsidian-knowledge-gateway" || manifest.private !== true
    || manifest.scripts?.start !== "node dist/src/secondBrainMcp.js"
    || manifest.scripts?.["start:http"] !== "node dist/src/secondBrainHttp.js"
    || Object.entries(requiredEntries).some(([name, target]) => manifest.bin?.[name] !== target)) {
  throw new Error("Release manifest does not make the compiled second brain the default.");
}
const environment = JSON.parse(fs.readFileSync(runtimeEnv, "utf8"));
if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
  throw new Error("Private runtime environment JSON must be an object.");
}
const catalog = environment.OBSIDIAN_SECOND_BRAIN_CATALOG_PATH;
if (typeof catalog !== "string" || !path.isAbsolute(catalog)) {
  throw new Error("Private runtime configuration must name an absolute compiled catalog.");
}
const existing = [source, config, runtimeEnv, catalog]
  .map((item) => fs.realpathSync(path.resolve(item)));
const unresolved = [install, skill, backup].map((item) => {
  const absolute = path.resolve(item);
  return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
});
const resolved = [...existing, ...unresolved];
const overlaps = (first, second) => {
  const relative = path.relative(first, second);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
};
for (const item of resolved) {
  if (item === path.parse(item).root) throw new Error("Install paths cannot be filesystem roots.");
}
for (let first = 0; first < resolved.length; first += 1) {
  for (let second = first + 1; second < resolved.length; second += 1) {
    if (overlaps(resolved[first], resolved[second]) || overlaps(resolved[second], resolved[first])) {
      throw new Error("Release, install, Skill, config, backup, runtime config, and catalog paths must not overlap.");
    }
  }
}
' "$source_directory" "$install_directory" "$skill_target" "$config_file" "$backup_file" "$runtime_environment_file"

# This validates private file ownership/mode, config schema, the catalog
# checksum, READY/CURRENT generations, embedding compatibility, and status.
"$node_executable" "$source_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$source_directory/dist/src/secondBrainMcp.js" \
	"$runtime_environment_file" >/dev/null

if ! mkdir "$lock_directory" 2>/dev/null; then
	echo "Another local MCP install appears to be running." >&2
	exit 1
fi

rollback_failed_install() {
	status=$?
	trap - EXIT HUP INT TERM
	if [ "$completed" = false ]; then
		if [ "$config_may_have_changed" = true ] && [ -f "$backup_file" ]; then
			cp -p "$backup_file" "$config_restore" 2>/dev/null || true
			mv -f "$config_restore" "$config_file" 2>/dev/null || true
		fi
		if [ "$skill_moved" = true ]; then rm -rf -- "$skill_target" 2>/dev/null || true; fi
		if [ "$installed_moved" = true ]; then rm -rf -- "$install_directory" 2>/dev/null || true; fi
	fi
	rm -rf -- "$install_stage" "$skill_stage" 2>/dev/null || true
	rmdir "$lock_directory" 2>/dev/null || true
	exit "$status"
}
trap rollback_failed_install EXIT HUP INT TERM

mkdir "$install_stage" "$skill_stage"
cp -R \
	"$source_directory/dist" \
	"$source_directory/node_modules" \
	"$source_directory/package.json" \
	"$source_directory/pnpm-lock.yaml" \
	"$install_stage/"
mkdir "$install_stage/scripts"
cp -p \
	"$source_directory/scripts/smoke-client.mjs" \
	"$source_directory/scripts/test.mjs" \
	"$source_directory/scripts/upgrade-local.sh" \
	"$install_stage/scripts/"
cp -R "$source_directory/skills/obsidian-knowledge/." "$skill_stage/"
find "$install_stage" "$skill_stage" -type f -name '._*' -exec rm -f -- {} +

cp -p "$config_file" "$backup_file"
chmod 600 "$backup_file"
mv "$install_stage" "$install_directory"
installed_moved=true
mv "$skill_stage" "$skill_target"
skill_moved=true

register_second_brain() {
	"$node_executable" --input-type=module -e '
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const [runtimeEnv, codex, node, server] = process.argv.slice(1);
const allowed = new Set([
  "OBSIDIAN_SECOND_BRAIN_CATALOG_PATH", "OBSIDIAN_EMBEDDING_PROVIDER",
  "OBSIDIAN_EMBEDDING_DIMENSION", "OBSIDIAN_EMBEDDING_MODEL", "OBSIDIAN_EMBEDDING_PORT",
  "OBSIDIAN_RERANKER_PROVIDER", "OBSIDIAN_RERANKER_MODEL", "OBSIDIAN_RERANKER_PORT",
  "OBSIDIAN_PRINCIPAL_ID", "OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS",
  "OBSIDIAN_PRINCIPAL_ALLOWED_PROJECT_IDS", "OBSIDIAN_PRINCIPAL_ALLOWED_MODES",
  "OBSIDIAN_PRINCIPAL_INCLUDED_PATH_PREFIXES", "OBSIDIAN_PRINCIPAL_EXCLUDED_PATH_PREFIXES",
  "OBSIDIAN_TRANSMISSION_REVIEW", "OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL",
  "OBSIDIAN_ALLOW_CRITICAL_WRITES",
]);
const environment = JSON.parse(fs.readFileSync(runtimeEnv, "utf8"));
const entries = Object.entries(environment).sort(([first], [second]) => first.localeCompare(second));
if (entries.some(([key, value]) => !allowed.has(key) || typeof value !== "string")) {
  throw new Error("Private runtime environment JSON contains an unsupported value.");
}
const args = ["mcp", "add", "obsidian_knowledge"];
for (const [key, value] of entries) args.push("--env", `${key}=${value}`);
args.push("--", node, server);
const result = spawnSync(codex, args, { stdio: "inherit" });
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
' "$runtime_environment_file" "$codex_executable" "$node_executable" \
		"$install_directory/dist/src/secondBrainMcp.js"
}

config_may_have_changed=true
register_second_brain

"$node_executable" "$install_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$install_directory/dist/src/secondBrainMcp.js" \
	"$runtime_environment_file" >/dev/null

completed=true
rmdir "$lock_directory"
trap - EXIT HUP INT TERM

echo "Installed compiled obsidian_knowledge MCP and obsidian-knowledge Skill; config backup: $backup_file"
