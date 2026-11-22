#!/usr/bin/env bash
# Configure the current user's Codex CLI for Drift Space.
set +x
set -eu
umask 077

configure_drift() {
  command -v codex >/dev/null || { echo '请先安装 Codex CLI，再运行本命令。' >&2; return 1; }
  command -v python3 >/dev/null || { echo '请先安装 Python 3.11 或更新版本。' >&2; return 1; }
  python3 - <<'DRIFT_PYTHON'
from contextlib import contextmanager
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import warnings

try:
    import tomllib
except ImportError:
    try:
        from pip._vendor import tomli as tomllib
    except ImportError:
        sys.exit("请先安装 Python 3.11 或更新版本，再运行本命令。")

BASE = "https://drift.kakamlab.com/api/openai/v1"
KEY = re.compile(r"dsk_[A-Za-z0-9_-]{43}")
MODEL = re.compile(r"gpt-(\d+)(?:\.(\d+))?(-codex(?:-max|-mini)?|-mini|-nano)?(-\d{4}-\d{2}-\d{2})?")
PROVIDER = dict(name="Drift Space", base_url=BASE, wire_api="responses", supports_websockets=False)


def fail(message):
    sys.exit(message)


def prior_key(config, provider):
    selected = config.get("model_providers", {}).get(provider, {})
    token = selected.get("experimental_bearer_token", "")
    if selected.get("base_url") == BASE and isinstance(token, str) and KEY.fullmatch(token):
        return token
    try:
        token, base = (Path.home() / ".codex-drift" / "connection").read_text().splitlines()
        if base == BASE and KEY.fullmatch(token):
            return token
    except (OSError, ValueError):
        pass
    return ""


def ask_key(saved):
    prompt = "设备 Key（输入隐藏，回车沿用已有 Key）：" if saved else "粘贴 Drift 设备 Key（dsk_ 开头，输入隐藏），按回车："
    warnings.simplefilter("error", getpass.GetPassWarning)
    try:
        with open("/dev/tty", "w") as tty:
            key = getpass.getpass(prompt, stream=tty).strip() or saved
    except (OSError, EOFError, getpass.GetPassWarning):
        fail("请在交互式终端中运行此命令。")
    if not KEY.fullmatch(key):
        fail("请输入完整的 Drift 设备 Key（dsk_ 开头）。")
    return key


def list_models(key):
    print("正在验证设备 Key…", flush=True)
    reply = subprocess.run(
        ["curl", "-q", "--silent", "--show-error", "--max-time", "20", "--proto", "=https",
         "-H", "@-", "--write-out", "\n%{http_code}", BASE + "/models"],
        input=("Authorization: Bearer " + key + "\n").encode(), capture_output=True,
    )
    body, _, status = reply.stdout.rpartition(b"\n")
    if reply.returncode:
        fail("连接 Drift 失败，请检查网络后重试。")
    if status != b"200":
        code = status.decode() if re.fullmatch(rb"[0-9]{3}", status) else "异常"
        fail("模型列表验证失败（HTTP " + code + "），请检查设备 Key 和转发设置。")
    try:
        return [m["id"] for m in json.loads(body)["data"]
                if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"].isprintable() and m["id"]]
    except (ValueError, KeyError, TypeError):
        fail("转发地址返回的模型列表无法读取。")


def select_model(models, current):
    def rank(model):
        major, minor, variant, snapshot = MODEL.fullmatch(model).groups()
        return (int(major), int(minor or 0), variant == "-codex", variant == "-codex-max",
                variant is None, not snapshot, model)
    if current in models:
        return current
    candidates = [m for m in models if MODEL.fullmatch(m)]
    if candidates:
        return max(candidates, key=rank)
    if not models:
        fail("设备 Key 已通过验证，但模型列表为空。")
    print("可用模型：" + "、".join(sorted(models)), flush=True)
    print("输入要用于 Codex 的模型 ID：", end="", flush=True)
    with open("/dev/tty") as tty:
        selected = tty.readline().strip()
    if selected not in models:
        fail("请选择列表中的模型 ID，再次运行命令。")
    return selected


def assign(config, path, value):
    for part in path[:-1]:
        config = config[part]
    config[path[-1]] = value


def parses_as(text, expected):
    try:
        return tomllib.loads(text) == expected
    except ValueError:
        return False


def set_string(text, path, value):
    # Verify the parsed change so similar keys in other tables and multiline strings are preserved.
    current = tomllib.loads(text)
    table = current
    for part in path[:-1]:
        table = table[part]
    name = path[-1]
    if table.get(name) == value:
        return text
    if name not in table and len(path) == 1:
        return name + " = " + json.dumps(value) + "\n" + text
    assign(current, path, value)
    identifier = rf"""(?:\b{re.escape(name)}\b|"{re.escape(name)}"|'{re.escape(name)}')"""
    double = r'(?:\\.|[^"\\\n])*'
    single = r"[^'\n]*"
    triple = "\"" * 3
    literal = "'" * 3
    string = rf'(?:{triple}(?:\\[\s\S]|(?!{triple})[\s\S])*{triple}"{{0,2}}|{literal}[\s\S]*?{literal}\'{{0,2}}|"{double}"|\'{single}\')'
    for match in re.finditer(identifier + r"[ \t]*=[ \t]*(" + string + ")", text):
        candidate = text[:match.start(1)] + json.dumps(value) + text[match.end(1):]
        if parses_as(candidate, current):
            return candidate
    fail("无法完整保留现有 TOML 的写法，已取消配置。")


def configure(text, config, provider, key, model):
    profiles = config.get("profiles", {})
    profile = config.get("profile")
    active = profiles.get(profile, {})
    for name, value in (("model_provider", provider), ("model", model)):
        text = set_string(text, [name], value)
        if name in active:
            text = set_string(text, ["profiles", profile, name], value)

    existing = config.get("model_providers", {}).get(provider)
    if existing is not None:
        return set_string(text, ["model_providers", provider, "experimental_bearer_token"], key)
    values = {**PROVIDER, "experimental_bearer_token": key}
    lines = [name + " = " + json.dumps(value) for name, value in values.items()]
    section = "[model_providers." + provider + "]\n" + "\n".join(lines) + "\n"
    result = text + ("\n" if text.endswith("\n") else "\n\n") + section
    expected = tomllib.loads(text)
    expected.setdefault("model_providers", {})[provider] = values
    if parses_as(result, expected):
        return result
    # An inline model_providers table must be extended inside its own braces.
    inline = provider + " = { " + ", ".join(lines) + " }"
    if config.get("model_providers"):
        inline += ", "
    key_name = r"""(?:\bmodel_providers\b|"model_providers"|'model_providers')"""
    for match in re.finditer(key_name + r"[ \t]*=[ \t]*\{", text):
        result = text[:match.end()] + inline + text[match.end():]
        if parses_as(result, expected):
            return result
    fail("无法完整保留现有模型供应商配置，已取消配置。")


def read_config(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        fail("config.toml 是链接或非普通文件，请选择独立的 Codex 配置目录。")
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def main():
    root = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser().absolute()
    path = root / "config.toml"
    print("Drift Space · 配置 Codex CLI\n将使用 " + str(path), flush=True)
    original = read_config(path)
    text = (original or b"").decode("utf-8")
    config = tomllib.loads(text)
    providers = config.get("model_providers", {})
    provider = "drift_space"
    index = 1
    while provider in providers:
        entry = dict(providers[provider])
        token = entry.pop("experimental_bearer_token", None)
        if entry == PROVIDER and isinstance(token, str):
            break
        index += 1
        provider = "drift_space_" + str(index)
    active = config.get("profiles", {}).get(config.get("profile"), {})
    key = ask_key(prior_key(config, provider))
    model = select_model(list_models(key), active.get("model", config.get("model")))
    result = configure(text, config, provider, key, model).encode("utf-8")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with directory_lock(root):
        if read_config(path) != original:
            fail("检测到其他程序修改了配置，请重新运行。")
        if original != result:
            if original is not None:
                with tempfile.NamedTemporaryFile(dir=root, prefix="config.toml.drift-backup-", delete=False) as backup:
                    backup.write(original)
                print("原配置备份：" + backup.name)
            with tempfile.NamedTemporaryFile(dir=root, prefix=".drift-", delete=False) as staged:
                try:
                    staged.write(result)
                    staged.flush()
                    os.fsync(staged.fileno())
                    os.replace(staged.name, path)
                finally:
                    if os.path.exists(staged.name):
                        os.unlink(staged.name)
        else:
            path.chmod(0o600)
    print("配置完成。模型：" + model + "。在项目目录运行 codex 即可开始。")


@contextmanager
def directory_lock(root):
    fd = os.open(root, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def cancel(signum, frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGHUP, cancel)
try:
    main()
except KeyboardInterrupt:
    fail("\n已取消。")
except (ValueError, TypeError, AttributeError, KeyError):
    fail("无法解析现有 Codex 配置，请检查 config.toml 后重试。")
except OSError as error:
    fail("配置失败：" + str(error.strerror or "无法读取或写入文件"))
DRIFT_PYTHON
}

configure_drift
