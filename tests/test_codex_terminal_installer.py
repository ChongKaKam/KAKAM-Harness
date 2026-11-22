"""Run with python3 -m unittest discover -s tests -p test_codex_terminal_installer.py."""

import errno
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time
import tomllib
import unittest


INSTALLER = Path(__file__).resolve().parents[1] / "public" / "install.sh"
BASE_URL = "https://drift.kakamlab.com/api/openai/v1"
KEY = "dsk_" + "A" * 43
AUTH = b'{"existing_login":"preserve this fixture"}\n'
PREFS = (
    '# local preference\nmodel_provider = "other"\nmodel = "gpt-5.4"\n'
    '[model_providers.other]\nname = "Other"\nbase_url = "http://localhost:8123/v1"\n'
    '[projects."/some/project"]\ntrust_level = "trusted"\n'
)
CURL_FIXTURE = """import json, os, sys
from pathlib import Path
args = sys.argv[1:]
key = os.environ["FIXTURE_KEY"]
assert not any(key in a for a in args), "device key exposed in curl arguments"
assert args[-1] == os.environ["FIXTURE_URL"] + "/models"
assert sys.stdin.read().strip() == "Authorization: Bearer " + key
Path(os.environ["FIXTURE_PROBE"]).touch()
print(json.dumps({"data":[{"id":"gpt-5.4"}]}) + "\\n" + os.environ["FIXTURE_HTTP"], end="")
"""


def piped_install(home, env, key_input, script=INSTALLER):
    """Run the public shell via a pipe, enter the key only after tty echo is disabled."""
    pid, terminal = pty.fork()
    if pid == 0:
        try:
            os.chdir(home)
            curl = shutil.which("curl", path=os.defpath)
            os.execve("/bin/bash", ["bash", "-o", "pipefail", "-c",
                                    '"$1" -fsSL "$2" | /bin/bash', "fixture",
                                    curl, script.as_uri()], env)
        finally:
            os._exit(127)
    output = bytearray()
    sent = False
    done = False
    try:
        end = time.monotonic() + 18
        while time.monotonic() < end:
            if not sent and "设备 Key".encode() in output and not termios.tcgetattr(terminal)[3] & termios.ECHO:
                os.write(terminal, key_input.encode() + b"\n")
                sent = True
            if select.select([terminal], [], [], 0.05)[0]:
                try:
                    data = os.read(terminal, 32768)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    break
                if not data:
                    break
                output.extend(data)
        else:
            raise AssertionError("Timed out waiting for terminal installer")
        _, status = os.waitpid(pid, 0)
        done = True
        if KEY.encode() in output:
            raise AssertionError("Device key was printed to the terminal")
        return os.waitstatus_to_exitcode(status), output.decode(errors="replace")
    finally:
        if not done:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)
        os.close(terminal)


class TerminalInstaller(unittest.TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory(prefix="drift-terminal-")
        self.addCleanup(storage.cleanup)
        self.home = Path(storage.name).resolve()
        self.config_dir = self.home / ".codex"
        self.config_dir.mkdir()
        self.config = self.config_dir / "config.toml"
        self.config.write_text(PREFS)
        self.auth = self.config_dir / "auth.json"
        self.auth.write_bytes(AUTH)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        curl = self.bin / "curl"
        curl.write_text("#!" + sys.executable + "\n" + CURL_FIXTURE)
        curl.chmod(0o700)
        codex = self.bin / "codex"
        codex.write_text("#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.166.0'\n")
        codex.chmod(0o700)
        self.probe = self.home / "models-requested"
        self.env = {"HOME": str(self.home), "PATH": str(self.bin) + ":" + os.environ["PATH"],
                    "TERM": "xterm", "FIXTURE_KEY": KEY, "FIXTURE_URL": BASE_URL,
                    "FIXTURE_HTTP": "200", "FIXTURE_PROBE": str(self.probe)}

    def test_install_and_rerun_using_saved_key(self):
        code, output = piped_install(self.home, self.env, KEY)
        self.assertEqual(code, 0, output)
        self.assertTrue(self.probe.is_file())
        settings = tomllib.loads(self.config.read_text())
        provider = settings["model_providers"][settings["model_provider"]]
        self.assertEqual(provider["base_url"], BASE_URL)
        self.assertEqual(provider["wire_api"], "responses")
        self.assertIs(provider["supports_websockets"], False)
        self.assertTrue(provider["experimental_bearer_token"] == KEY)
        self.assertEqual(settings["model"], "gpt-5.4")
        self.assertEqual(settings["projects"]["/some/project"]["trust_level"], "trusted")
        self.assertEqual(settings["model_providers"]["other"]["name"], "Other")
        self.assertIn("# local preference", self.config.read_text())
        self.assertEqual(self.auth.read_bytes(), AUTH)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        backup, = self.config_dir.glob("config.toml.drift-backup-*")
        self.assertEqual(backup.read_text(), PREFS)
        self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
        first_config = self.config.read_bytes()
        self.probe.unlink()
        code, output = piped_install(self.home, self.env, "")
        self.assertEqual(code, 0, output)
        self.assertTrue(self.probe.is_file())
        self.assertTrue(first_config == self.config.read_bytes())
        self.assertEqual(self.auth.read_bytes(), AUTH)

    def test_migrate_legacy_key_and_active_profile(self):
        legacy_dir = self.home / ".codex-drift"
        legacy_dir.mkdir()
        connection = legacy_dir / "connection"
        connection.write_text(KEY + "\n" + BASE_URL + "\n")
        self.config.write_text(
            'profile = "work"\n' + PREFS +
            '[profiles.work]\nmodel_provider = "other"\nmodel = "previous-model"\n'
            '[profiles.personal]\nmodel_provider = "other"\n'
        )
        code, output = piped_install(self.home, self.env, "")
        self.assertEqual(code, 0, output)
        self.assertTrue(self.probe.is_file())
        settings = tomllib.loads(self.config.read_text())
        self.assertEqual(settings["profiles"]["work"]["model_provider"], settings["model_provider"])
        self.assertEqual(settings["profiles"]["work"]["model"], "gpt-5.4")
        self.assertEqual(settings["profiles"]["personal"], {"model_provider": "other"})
        self.assertTrue(connection.read_text().splitlines() == [KEY, BASE_URL])
        self.assertEqual(self.auth.read_bytes(), AUTH)

    def test_without_tty_aborts_before_probing_or_writing(self):
        result = subprocess.run(["/bin/bash"], input=INSTALLER.read_bytes(), env=self.env,
                                start_new_session=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.probe.exists())
        self.assertEqual(self.config.read_text(), PREFS)
        self.assertFalse(list(self.config_dir.glob("config.toml.drift-backup-*")))

    def test_rejected_key_leaves_existing_config_intact(self):
        self.env["FIXTURE_HTTP"] = "401"
        code, output = piped_install(self.home, self.env, KEY)
        self.assertNotEqual(code, 0)
        self.assertTrue(self.probe.is_file())
        self.assertIn("401", output)
        self.assertEqual(self.config.read_text(), PREFS)
        self.assertEqual(self.auth.read_bytes(), AUTH)
        self.assertFalse(list(self.config_dir.glob("config.toml.drift-backup-*")))


if __name__ == "__main__":
    unittest.main()
