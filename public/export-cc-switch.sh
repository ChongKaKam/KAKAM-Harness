#!/bin/sh
set -eu
python3 - "$@" <<'PY'
from base64 import urlsafe_b64encode
from html import escape
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode
import re, sqlite3, sys

root = Path.home() / ".codex-drift"
try:
    key, base = (root / "connection").read_text().splitlines()
except (OSError, ValueError):
    sys.exit("请在已安装 codex-drift 的用户账号下运行。")
if base != "https://drift.kakamlab.com/api/openai/v1" or not re.fullmatch(r"dsk_[A-Za-z0-9_-]{43}", key):
    sys.exit("连接文件中的设备密钥格式或 Drift 地址不符。")
model = sys.argv[1] if len(sys.argv) > 1 else ""
if not model:
    # Codex records the model used for each thread in its local state database.
    for db in sorted(root.glob("state_*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            conn = sqlite3.connect(db.as_uri()+"?mode=ro", uri=True)
            try:
                row = conn.execute("SELECT model FROM threads WHERE model_provider='drift' AND model IS NOT NULL AND model<>'' ORDER BY updated_at DESC LIMIT 1").fetchone()
            finally:
                conn.close()
            if row:
                model = row[0]
                break
        except sqlite3.Error:
            continue
model = model or "gpt-5-codex"
settings = b'model_provider = "custom"\n[model_providers.custom]\nwire_api = "responses"\nsupports_websockets = false\n'
params = dict(resource="provider", app="codex", name="Drift Space", endpoint=base,
              apiKey=key, model=model, apiFormat="openai_responses", enabled="false",
              configFormat="toml", config=urlsafe_b64encode(settings).decode().rstrip("="))
link = "ccswitch://v1/import?" + urlencode(params)
with NamedTemporaryFile(mode="w", encoding="utf-8", dir=root, prefix="Drift-CC-Switch-", suffix=".html", delete=False) as out:
    out.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">')
    out.write("<title>Drift Space · CC Switch</title><main><h1>Drift Space</h1><p>Codex · "+escape(model)+"</p>")
    out.write('<p><a rel="noreferrer" href="'+escape(link, quote=True)+'">导入到 CC Switch</a></p><p>此文件含设备密钥，请仅在自己的目标设备打开。</p></main></html>')
print("已生成配置："+out.name)
print("模型："+model+"。在安装 CC Switch 的电脑上打开此文件，点「导入到 CC Switch」。")
PY
