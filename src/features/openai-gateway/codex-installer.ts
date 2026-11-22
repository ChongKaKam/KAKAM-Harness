const launcherMarker = '# Drift Space 管理的 Codex 启动器';

const launcher = String.raw`#!/usr/bin/env bash
${launcherMarker}
set +x
set -eu
export CODEX_HOME="$HOME/.codex-drift"
{
  IFS= read -r DRIFT_CODEX_KEY
  IFS= read -r drift_base_url
} < "$CODEX_HOME/connection"
export DRIFT_CODEX_KEY
exec codex --no-daemon \
  -c 'model_provider="drift"' \
  -c 'model_providers.drift.name="Drift Space"' \
  -c "model_providers.drift.base_url=\"$drift_base_url\"" \
  -c 'model_providers.drift.env_key="DRIFT_CODEX_KEY"' \
  -c 'model_providers.drift.wire_api="responses"' \
  -c 'model_providers.drift.supports_websockets=false' "$@"`;

export function createCodexInstaller(origin: string, deviceKey?: string) {
  const url = new URL(origin);
  // Only a browser origin, never credentials, shell syntax or a user-supplied path.
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !/^(?:[a-z0-9._-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('当前站点地址无法用于生成配置脚本。');
  if (deviceKey !== undefined && !/^dsk_[A-Za-z0-9_-]{43}$/.test(deviceKey))
    throw new Error('设备密钥格式有误，请重新签发。');

  const readKey =
    deviceKey === undefined
      ? String.raw`tty_state=$(stty -g </dev/tty)
trap 'stty "$tty_state" </dev/tty' EXIT
trap 'exit 1' HUP INT TERM
stty -echo </dev/tty
IFS= read -r -s -p '粘贴开发机转发密钥并按回车（输入隐藏）：' drift_key </dev/tty
stty "$tty_state" </dev/tty
trap - EXIT HUP INT TERM
printf '\n' >&2`
      : `drift_key='${deviceKey}'`;

  const setup = String.raw`set +x
set -eu
umask 077
private_dir="$HOME/.codex-drift"
bin_dir="$HOME/.local/bin"
entry="$bin_dir/codex-drift"

if [[ -L "$private_dir" || -L "$private_dir/connection" || -d "$private_dir/connection" ]]; then
  echo '独立配置路径已被占用，请检查 ~/.codex-drift。' >&2
  exit 1
fi
if [[ -L "$entry" ]] || { [[ -e "$entry" ]] && { [[ ! -f "$entry" ]] || ! grep -Fxq '${launcherMarker}' "$entry"; }; }; then
  echo '启动路径已被其他文件占用，请检查 ~/.local/bin/codex-drift。' >&2
  exit 1
fi

${readKey}
if [[ ! "$drift_key" =~ ^dsk_[A-Za-z0-9_-]{43}$ ]]; then
  echo '密钥格式有误，请复制完整的 dsk_ 设备密钥。' >&2
  exit 1
fi

mkdir -p "$private_dir" "$bin_dir"
chmod 700 "$private_dir"
connection_tmp=$(mktemp "$private_dir/.connection.XXXXXX")
entry_tmp=''
trap 'rm -f -- "$connection_tmp" "$entry_tmp"' EXIT
entry_tmp=$(mktemp "$bin_dir/.codex-drift.XXXXXX")
printf '%s\n' "$drift_key" '${url.origin}/api/openai/v1' > "$connection_tmp"
unset drift_key
cat > "$entry_tmp" <<'DRIFT_CODEX_LAUNCHER'
${launcher}
DRIFT_CODEX_LAUNCHER
chmod 600 "$connection_tmp"
chmod 700 "$entry_tmp"
mv -f "$entry_tmp" "$entry"
mv -f "$connection_tmp" "$private_dir/connection"
printf '%s\n' '配置完成。请在项目目录运行 ~/.local/bin/codex-drift。'`;
  // A pasted here-document never includes a credential. Read the key from the terminal itself.
  return deviceKey === undefined
    ? `bash <<'DRIFT_CODEX_SETUP'\n${setup}\nDRIFT_CODEX_SETUP\n`
    : `#!/usr/bin/env bash\n${setup}\n`;
}
