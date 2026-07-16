#!/bin/sh
set -eu

realRunc="$HOME/bin/runc.real"
commandName=""
bundle=""
previous=""

for argument in "$@"; do
  if [ -z "$commandName" ] && { [ "$argument" = "create" ] || [ "$argument" = "run" ] || [ "$argument" = "delete" ]; }; then
    commandName="$argument"
  fi
  if [ "$previous" = "--bundle" ]; then
    bundle="$argument"
  fi
  previous="$argument"
done

if [ "$commandName" = "create" ] && [ -n "$bundle" ] && [ -f "$bundle/config.json" ]; then
  node - "$bundle/config.json" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const spec = JSON.parse(fs.readFileSync(path, "utf8"));
if (spec.linux !== undefined) {
  delete spec.linux.resources;
  delete spec.linux.cgroupsPath;
}
for (const mount of spec.mounts ?? []) {
  if (mount.destination === "/dev/pts") {
    mount.options = (mount.options ?? []).map((option) => /^gid=\d+$/.test(option) ? "gid=0" : option);
  }
}
fs.writeFileSync(path, `${JSON.stringify(spec)}\n`);
NODE
fi

exec "$realRunc" "$@"
