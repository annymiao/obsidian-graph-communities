#!/bin/sh

set -eu
umask 077
COPYFILE_DISABLE=1
export COPYFILE_DISABLE

show_migration() {
	echo "usage: upgrade-local.sh SOURCE INSTALL SKILLS CODEX NODE CONFIG BACKUP PRIVATE_RUNTIME_ENV_JSON" >&2
	echo "Legacy Vault/request-time arguments are not accepted by the v1.3 default." >&2
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
codex_executable=$4
node_executable=$5
config_file=$6
backup_directory=$7
runtime_environment_file=$8
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

for protected_path in "$install_directory" "$skill_target" "$backup_directory" "$runtime_environment_file"; do
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
	"$source_directory/dist/src/http.js"; do
	if [ ! -f "$required_file" ]; then
		echo "The v1.3 MCP release is incomplete; refusing to upgrade." >&2
		exit 1
	fi
done
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
if [ ! -f "$runtime_environment_file" ] || [ -L "$runtime_environment_file" ]; then
	show_migration
	echo "Private runtime environment JSON must be a real regular file." >&2
	exit 1
fi
if [ ! -f "$install_directory/package.json" ]; then
	echo "Existing MCP install is missing its package manifest." >&2
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
const [source, install, skill, config, backup, runtimeEnv] = process.argv.slice(1);
const environment = JSON.parse(fs.readFileSync(runtimeEnv, "utf8"));
if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
  throw new Error("Private runtime environment JSON must be an object.");
}
const catalog = environment.OBSIDIAN_SECOND_BRAIN_CATALOG_PATH;
if (typeof catalog !== "string" || !path.isAbsolute(catalog)) {
  throw new Error("Private runtime configuration must name an absolute compiled catalog.");
}
const existing = [source, install, skill, config, runtimeEnv, catalog]
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
      throw new Error("Upgrade source, install, Skill, config, backup, runtime config, and catalog paths must not overlap.");
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
' "$source_directory" "$install_directory" "$skill_target" "$config_file" "$backup_directory" "$runtime_environment_file"

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
const expectedBins = {
  "obsidian-knowledge-mcp": "dist/src/secondBrainMcp.js",
  "obsidian-knowledge-gateway": "dist/src/secondBrainHttp.js",
  "obsidian-second-brain-compile": "dist/src/offlineCompile.js",
  "obsidian-knowledge-mcp-legacy": "dist/src/index.js",
  "obsidian-knowledge-gateway-legacy": "dist/src/http.js",
};
for (const [name, target] of Object.entries(expectedBins)) {
  if (manifest.bin?.[name] !== target || !fs.statSync(path.join(root, target)).isFile()) {
    throw new Error(`Release entry ${name} is invalid.`);
  }
}
if (manifest.scripts?.start !== "node dist/src/secondBrainMcp.js"
    || manifest.scripts?.["start:http"] !== "node dist/src/secondBrainHttp.js") {
  throw new Error("Default start scripts must use the compiled second-brain services.");
}
const mcpEntry = await import(
  pathToFileURL(path.join(root, "dist", "src", "secondBrainMcp.js")).href
);
const httpEntry = await import(
  pathToFileURL(path.join(root, "dist", "src", "secondBrainHttp.js")).href
);
const compileEntry = await import(
  pathToFileURL(path.join(root, "dist", "src", "offlineCompile.js")).href
);
if (mcpEntry.SECOND_BRAIN_MCP_VERSION !== manifest.version
    || httpEntry.SECOND_BRAIN_HTTP_VERSION !== manifest.version
    || compileEntry.SECOND_BRAIN_COMPILE_VERSION !== manifest.version) {
  throw new Error("Compiled second-brain versions do not match package.json.");
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

# Fail before backup or mutation unless the private config, compiled catalog,
# READY/CURRENT generations, embedding contract, ACL, and redacted status work.
"$node_executable" "$source_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$source_directory/dist/src/secondBrainMcp.js" \
	"$runtime_environment_file" >/dev/null

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

"$node_executable" "$install_stage/scripts/smoke-client.mjs" \
	"$node_executable" "$install_stage/dist/src/secondBrainMcp.js" \
	"$runtime_environment_file" >/dev/null

# A complete backup is created before any installed file or Codex configuration
# can be replaced. BACKUP_READY is written last and existing backups are never reused.
cp -R "$install_directory" "$backup_directory/install"
cp -R "$skill_target" "$backup_directory/skill"
cp -p "$config_file" "$backup_directory/config.toml"
chmod 600 "$backup_directory/config.toml"
printf '%s\n' 'backup_format=obsidian-knowledge-mcp-v2' > "$backup_directory/BACKUP_READY"

# Each rename is atomic on its destination filesystem. The trap restores the old
# pair and the saved config if any later step fails.
mv "$install_directory" "$old_install"
mv "$install_stage" "$install_directory"
mv "$skill_target" "$old_skill"
mv "$skill_stage" "$skill_target"

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
"$codex_executable" mcp remove obsidian_knowledge
register_second_brain

"$node_executable" "$install_directory/scripts/smoke-client.mjs" \
	"$node_executable" "$install_directory/dist/src/secondBrainMcp.js" \
	"$runtime_environment_file" >/dev/null

completed=true
rm -rf -- "$old_install" "$old_skill"
rmdir "$lock_directory"
trap - EXIT HUP INT TERM

echo "Upgraded compiled obsidian_knowledge MCP and Skill. Rollback backup retained at: $backup_directory"
