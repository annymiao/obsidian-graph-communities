#!/bin/sh

set -eu
umask 077
COPYFILE_DISABLE=1
export COPYFILE_DISABLE

if [ "$#" -ne 10 ]; then
	echo "usage: upgrade-local.sh SOURCE INSTALL SKILLS CODEX NODE CONFIG BACKUP SOURCE_ENV SOURCE_VALUE REVIEW_MODE" >&2
	exit 2
fi

source_directory=$1
install_directory=$2
skills_directory=$3
codex_executable=$4
node_executable=$5
config_file=$6
backup_directory=$7
source_env_name=$8
source_env_value=$9
review_mode=${10}
# Keep staging and old-version paths as siblings even when a caller supplies a
# conventional trailing slash on a directory argument.
while [ "$install_directory" != "/" ] && [ "${install_directory%/}" != "$install_directory" ]; do
	install_directory=${install_directory%/}
done
while [ "$skills_directory" != "/" ] && [ "${skills_directory%/}" != "$skills_directory" ]; do
	skills_directory=${skills_directory%/}
done
skill_target="$skills_directory/obsidian-knowledge"
process_token=$$
install_stage="${install_directory}.upgrade-${process_token}.stage"
skill_stage="${skill_target}.upgrade-${process_token}.stage"
old_install="${install_directory}.upgrade-${process_token}.old"
old_skill="${skill_target}.upgrade-${process_token}.old"
config_restore="${config_file}.upgrade-${process_token}.restore"
lock_directory="${install_directory}.upgrade.lock"
config_may_have_changed=false
completed=false

case "$review_mode" in
	required|trusted-local|disabled) ;;
	*)
		echo "REVIEW_MODE must be required, trusted-local, or disabled." >&2
		exit 2
		;;
esac
case "$source_env_name" in
	OBSIDIAN_VAULT_PATH|OBSIDIAN_SOURCES_JSON) ;;
	*)
		echo "SOURCE_ENV must be OBSIDIAN_VAULT_PATH or OBSIDIAN_SOURCES_JSON." >&2
		exit 2
		;;
esac

for protected_path in "$install_directory" "$skill_target" "$backup_directory"; do
	case "$protected_path" in
		''|/|.|..)
			echo "Install, Skill, and backup paths must be explicit non-root paths." >&2
			exit 2
			;;
	esac
done

if [ ! -f "$source_directory/dist/src/index.js" ]; then
	echo "MCP 1.2 build output is missing." >&2
	exit 1
fi
if [ ! -d "$source_directory/node_modules" ]; then
	echo "MCP runtime dependencies are missing." >&2
	exit 1
fi
if [ ! -f "$source_directory/skills/obsidian-knowledge/SKILL.md" ]; then
	echo "Obsidian knowledge Skill is missing." >&2
	exit 1
fi
if [ ! -f "$source_directory/scripts/smoke-client.mjs" ]; then
	echo "Smoke client is missing." >&2
	exit 1
fi
if [ ! -f "$source_directory/scripts/test.mjs" ]; then
	echo "MCP test runner is missing." >&2
	exit 1
fi
if [ ! -f "$source_directory/scripts/upgrade-local.sh" ]; then
	echo "MCP upgrade helper is missing." >&2
	exit 1
fi
if [ ! -d "$install_directory" ] || [ -L "$install_directory" ]; then
	echo "Existing MCP install must be a real directory." >&2
	exit 1
fi
if [ ! -d "$skill_target" ] || [ -L "$skill_target" ]; then
	echo "Existing Skill target must be a real directory." >&2
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
if [ ! -f "$install_directory/package.json" ]; then
	echo "Existing MCP install is missing its package manifest." >&2
	exit 1
fi
if [ "$source_env_name" = "OBSIDIAN_VAULT_PATH" ] && [ ! -d "$source_env_value" ]; then
	echo "The configured Vault directory does not exist." >&2
	exit 1
fi
if [ -e "$backup_directory" ]; then
	echo "Backup target already exists; refusing to overwrite it." >&2
	exit 1
fi
for temporary_path in "$install_stage" "$skill_stage" "$old_install" "$old_skill" "$config_restore"; do
	if [ -e "$temporary_path" ]; then
		echo "Upgrade staging path already exists; refusing to continue." >&2
		exit 1
	fi
done

# Resolve every target through its existing parent and reject overlapping
# layouts before a backup, rename, or cleanup can touch anything. Package and
# Skill markers keep an accidentally broad directory from being accepted as an
# installed service target.
"$node_executable" -e '
const fs = require("node:fs");
const path = require("node:path");
const [source, install, skill, config, backup] = process.argv.slice(1);
const existing = [source, install, skill, config]
  .map((item) => fs.realpathSync(path.resolve(item)));
const backupAbsolute = path.resolve(backup);
const backupName = path.basename(backupAbsolute);
if (!backupName || backupName === "." || backupName === "..") {
  throw new Error("Unsafe backup target.");
}
const resolved = [
  ...existing,
  path.join(fs.realpathSync(path.dirname(backupAbsolute)), backupName),
];
for (const item of resolved) {
  if (item === path.parse(item).root) {
    throw new Error("Upgrade paths cannot be filesystem roots.");
  }
}
const overlaps = (first, second) => {
  const relative = path.relative(first, second);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
for (let first = 0; first < resolved.length; first += 1) {
  for (let second = first + 1; second < resolved.length; second += 1) {
    if (overlaps(resolved[first], resolved[second]) || overlaps(resolved[second], resolved[first])) {
      throw new Error("Upgrade source, install, Skill, config, and backup paths must not overlap.");
    }
  }
}
const installed = JSON.parse(
  fs.readFileSync(path.join(existing[1], "package.json"), "utf8"),
);
const recognizedInstalledPackages = new Set([
  "agent-dashboard-obsidian-knowledge-mcp",
  "obsidian-knowledge-gateway",
]);
if (!recognizedInstalledPackages.has(installed.name)) {
  throw new Error("Existing install is not the expected MCP package.");
}
const skillText = fs.readFileSync(path.join(existing[2], "SKILL.md"), "utf8");
if (!/^---\r?\n[\s\S]*?^name:\s*obsidian-knowledge\s*$[\s\S]*?^---\s*$/mu.test(skillText)) {
  throw new Error("Existing Skill is not obsidian-knowledge.");
}
' "$source_directory" "$install_directory" "$skill_target" "$config_file" "$backup_directory"

validate_release_directory() {
	"$node_executable" --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = fs.realpathSync(path.resolve(process.argv[1]));
const allowAppleDouble = process.argv[2] === "allow-appledouble";
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
if (manifest.name !== "obsidian-knowledge-gateway" || manifest.private !== true) {
  throw new Error("Release package identity is invalid.");
}
if (typeof manifest.version !== "string"
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
  throw new Error("Release package version is invalid.");
}
const dependencies = manifest.dependencies;
if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
  throw new Error("Release dependencies are invalid.");
}
for (const [name, expected] of Object.entries(dependencies)) {
  if (typeof expected !== "string"
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(expected)) {
    throw new Error(`Dependency ${name} must use an exact version.`);
  }
  const installedPath = path.join(root, "node_modules", ...name.split("/"), "package.json");
  const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
  if (installed.name !== name || installed.version !== expected) {
    throw new Error(`Installed dependency ${name} does not match package.json.`);
  }
}
const entry = await import(pathToFileURL(path.join(root, "dist", "src", "index.js")).href);
if (entry.KNOWLEDGE_SERVICE_VERSION !== manifest.version) {
  throw new Error("Compiled server version does not match package.json.");
}
const pending = [root];
while (pending.length > 0) {
  const directory = pending.pop();
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!allowAppleDouble && item.name.startsWith("._")) {
      throw new Error("Release stage contains AppleDouble metadata.");
    }
    if (item.isDirectory()) pending.push(path.join(directory, item.name));
  }
}
' "$1" "${2:-}"
}

validate_release_directory "$source_directory" allow-appledouble
if ! mkdir "$lock_directory" 2>/dev/null; then
	echo "Another local MCP upgrade appears to be running." >&2
	exit 1
fi

rollback_failed_upgrade() {
	status=$?
	trap - EXIT HUP INT TERM
	if [ "$completed" = false ]; then
		if [ "$config_may_have_changed" = true ] && [ -f "$backup_directory/config.toml" ]; then
			cp -p "$backup_directory/config.toml" "$config_restore" 2>/dev/null || true
			mv -f "$config_restore" "$config_file" 2>/dev/null || true
		fi
		if [ -e "$old_skill" ]; then
			rm -rf -- "$skill_target" 2>/dev/null || true
			mv "$old_skill" "$skill_target" 2>/dev/null || true
		fi
		if [ -e "$old_install" ]; then
			rm -rf -- "$install_directory" 2>/dev/null || true
			mv "$old_install" "$install_directory" 2>/dev/null || true
		fi
	fi
	rm -rf -- "$install_stage" "$skill_stage" 2>/dev/null || true
	rmdir "$lock_directory" 2>/dev/null || true
	exit "$status"
}
trap rollback_failed_upgrade EXIT HUP INT TERM

mkdir "$install_stage" "$skill_stage" "$backup_directory"
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
# COPYFILE_DISABLE prevents new sidecars on macOS. Remove sidecars already
# present on removable media, then prove none remain in the staged release.
find "$install_stage" "$skill_stage" -type f -name '._*' -exec rm -f -- {} +
validate_release_directory "$install_stage"

# A complete backup is created before any installed file or Codex configuration
# can be replaced. BACKUP_READY is written last and existing backups are never reused.
cp -R "$install_directory" "$backup_directory/install"
cp -R "$skill_target" "$backup_directory/skill"
cp -p "$config_file" "$backup_directory/config.toml"
chmod 600 "$backup_directory/config.toml"
printf '%s\n' 'backup_format=obsidian-knowledge-mcp-v1' > "$backup_directory/BACKUP_READY"

"$node_executable" "$source_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$install_stage/dist/src/index.js" \
	"$source_env_name" "$source_env_value" "$review_mode" >/dev/null

# Each rename is atomic on its destination filesystem. The trap restores the old
# pair and the saved config if any later step fails.
mv "$install_directory" "$old_install"
mv "$install_stage" "$install_directory"
mv "$skill_target" "$old_skill"
mv "$skill_stage" "$skill_target"

config_may_have_changed=true
"$codex_executable" mcp remove obsidian_knowledge
"$codex_executable" mcp add obsidian_knowledge \
	--env "$source_env_name=$source_env_value" \
	--env "OBSIDIAN_TRANSMISSION_REVIEW=$review_mode" \
	-- "$node_executable" "$install_directory/dist/src/index.js"

"$node_executable" "$source_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$install_directory/dist/src/index.js" \
	"$source_env_name" "$source_env_value" "$review_mode" >/dev/null

completed=true
rm -rf -- "$old_install" "$old_skill"
rmdir "$lock_directory"
trap - EXIT HUP INT TERM

echo "Upgraded obsidian_knowledge MCP and Skill. Rollback backup retained at: $backup_directory"
