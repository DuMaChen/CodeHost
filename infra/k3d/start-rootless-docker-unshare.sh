#!/bin/sh
set -eu

cache="${AI_PLATFORM_REMOTE_CACHE:-$HOME/.cache/ai-platform}"
runRoot="$cache/unshare-run"
dataRoot="$cache/docker-data"
execRoot="/run/ai-platform-docker"
securityRoot="$cache/unshare-security"

mkdir -p "$runRoot" "$dataRoot" "$securityRoot"
mount --bind "$runRoot" /run
mount --bind "$securityRoot" /sys/kernel/security
mkdir -p /run/containerd /run/user/$(id -u) "$execRoot"

"$HOME/bin/slirp4netns" \
  --configure \
  --mtu=65520 \
  --disable-host-loopback \
  --api-socket="$cache/slirp4netns.sock" \
  "$$" tap0 >"$cache/slirp4netns.log" 2>&1 &
sleep 1

exec "$HOME/bin/dockerd" \
  --host="unix://$cache/docker.sock" \
  --data-root="$dataRoot" \
  --exec-root="$execRoot" \
  --storage-driver=vfs \
  --cgroup-parent=/ \
  --default-cgroupns-mode=host \
  --iptables=false \
  --userland-proxy=false \
  --host-gateway-ip=127.0.0.1
