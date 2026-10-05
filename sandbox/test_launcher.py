"""Unit tests for the trusted image-side clean-environment launcher."""

import importlib.machinery
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
_path = Path(__file__).with_name("codebridge-launch")
_loader = importlib.machinery.SourceFileLoader("codebridge_launch", str(_path))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
assert _spec is not None
launcher = importlib.util.module_from_spec(_spec)
_loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_copies_regular_files_into_workspace_and_preserves_executable_bits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codebridge-launcher-") as temporary:
            root = Path(temporary)
            source = root / "source"
            workspace = root / "workspace"
            (source / "nested").mkdir(parents=True)
            text_file = source / "nested" / "source.txt"
            text_file.write_text("captured snapshot\n", encoding="utf-8")
            executable = source / "run-check"
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o555)

            launcher.copy_snapshot(source, workspace)

            self.assertEqual((workspace / "nested" / "source.txt").read_text(), "captured snapshot\n")
            self.assertEqual((workspace / "nested" / "source.txt").stat().st_mode & 0o777, 0o444)
            self.assertEqual((workspace / "run-check").stat().st_mode & 0o777, 0o555)

    def test_refuses_symlinks_hardlinks_and_nonempty_workspaces(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codebridge-launcher-") as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            file = source / "data"
            file.write_text("data", encoding="utf-8")

            link_source = root / "symlink-source"
            link_source.mkdir()
            (link_source / "link").symlink_to(file)
            with self.assertRaises(SystemExit):
                launcher.copy_snapshot(link_source, root / "link-output")

            hardlink_source = root / "hardlink-source"
            hardlink_source.mkdir()
            (hardlink_source / "alias").hardlink_to(file)
            with self.assertRaises(SystemExit):
                launcher.copy_snapshot(hardlink_source, root / "hardlink-output")

            nonempty = root / "nonempty"
            nonempty.mkdir()
            (nonempty / "unexpected").write_text("x", encoding="utf-8")
            with self.assertRaises(SystemExit):
                launcher.copy_snapshot(source, nonempty)

    def test_clean_environment_contains_only_fixed_nonsecret_values(self) -> None:
        environment = launcher.clean_environment("/home/cb", "/tmp")
        self.assertEqual(environment["HOME"], "/home/cb")
        self.assertEqual(environment["TMPDIR"], "/tmp")
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertNotIn("GITHUB_TOKEN", environment)
        self.assertEqual(set(environment), {"HOME", "TMPDIR", "CI", "LANG", "LC_ALL", "NO_COLOR", "PATH"})


if __name__ == "__main__":
    unittest.main()
