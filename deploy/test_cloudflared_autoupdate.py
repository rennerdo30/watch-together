"""Offline safety tests; no Docker daemon or production configuration is read."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("updater", Path(__file__).with_name("cloudflared-autoupdate.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class CloudflaredUpdateTests(unittest.TestCase):
    def target(self):
        return {"id": "old", "project": "fixture", "service": "cloudflared", "cwd": "/fixture",
                "compose": ["docker", "compose", "--project-name", "fixture", "-f", "/fixture/compose.yml"],
                "image": "cloudflare/cloudflared:latest", "running_image": "sha256:old"}

    def test_databases_and_pinned_images_are_never_eligible(self):
        for image in ("postgres:latest", "app:latest", "cloudflare/cloudflared:2026.10.3"):
            with patch.object(updater, "command", return_value=image + " sha256:fixture true") as run:
                self.assertIsNone(updater.describe("fixture"))
                self.assertEqual(1, run.call_count)

    def test_stopped_tunnels_are_never_started(self):
        with patch.object(updater, "command", return_value="cloudflare/cloudflared:latest sha256:fixture false") as run:
            self.assertIsNone(updater.describe("fixture"))
            self.assertEqual(1, run.call_count)

    def test_no_image_change_means_no_restart(self):
        with patch.object(updater, "command", return_value="sha256:old") as run:
            updater.refresh(self.target())
            self.assertEqual(1, run.call_count)

    def test_dry_run_never_pulls_or_recreates(self):
        with patch.object(updater, "command") as run:
            updater.refresh(self.target(), dry_run=True)
            run.assert_not_called()

    def test_replacement_targets_only_the_tunnel_and_verifies_readiness(self):
        target = self.target()
        outputs = ["sha256:new", "", "replacement", "sha256:new", "cloudflared version 2026.10.3", "true none", "true none"]
        ready = subprocess.CompletedProcess([], 0, "", "Registered tunnel connection")
        with patch.object(updater, "command", side_effect=outputs) as run, patch.object(updater, "describe", return_value=target), patch.object(updater.subprocess, "run", return_value=ready), patch.object(updater.time, "sleep"):
            updater.refresh(target)
        args = run.call_args_list[1].args[0]
        self.assertEqual(["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--scale", "cloudflared=1", "cloudflared"], args[-9:])

    def test_concurrent_stop_or_deployment_change_prevents_recreation(self):
        with patch.object(updater, "command", return_value="sha256:new") as run, patch.object(updater, "describe", return_value=None):
            with self.assertRaises(RuntimeError):
                updater.refresh(self.target())
            self.assertEqual(1, run.call_count)

    def test_only_patched_images_can_be_started(self):
        for version in ("2026.9.3", "2026.10.0", "unrecognized"):
            with self.assertRaises(RuntimeError):
                updater.verify_version(version)
        updater.verify_version("cloudflared version 2026.10.3")
        updater.verify_version("cloudflared version 2026.11.0")

    def test_original_compose_and_environment_paths_are_preserved(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "compose.yml"
            env = Path(directory) / "private.env"
            config.touch()
            env.touch()
            labels = {"com.docker.compose.project": "fixture", "com.docker.compose.service": "cloudflared",
                      "com.docker.compose.project.working_dir": directory,
                      "com.docker.compose.project.config_files": str(config),
                      "com.docker.compose.project.environment_file": str(env), "com.docker.compose.config-hash": "fixture-hash"}
            with patch.object(updater, "command", side_effect=["cloudflare/cloudflared:latest sha256:old true", json.dumps(labels), "postgres:18\ncloudflare/cloudflared:latest", "cloudflared fixture-hash", "full-container-id", "full-container-id"]):
                target = updater.describe("fixture")
            self.assertIn(str(env), target["compose"])
            self.assertIn(str(config), target["compose"])
            self.assertNotIn("--build", target["compose"])

    def test_stale_registration_cannot_hide_a_crashed_container(self):
        target = self.target()
        outputs = ["sha256:new", "", "replacement", "sha256:new", "cloudflared version 2026.10.3"] + ["false none"] * 30
        registered = subprocess.CompletedProcess([], 0, "", "Registered tunnel connection")
        with patch.object(updater, "command", side_effect=outputs), patch.object(updater, "describe", return_value=target), patch.object(updater.subprocess, "run", return_value=registered), patch.object(updater.time, "sleep"):
            with self.assertRaises(RuntimeError):
                updater.refresh(target)

    def test_config_drift_and_stopped_sibling_fail_closed(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "compose.yml"
            config.touch()
            labels = {"com.docker.compose.project": "fixture", "com.docker.compose.service": "cloudflared",
                      "com.docker.compose.project.working_dir": directory,
                      "com.docker.compose.project.config_files": str(config), "com.docker.compose.config-hash": "expected"}
            initial = ["cloudflare/cloudflared:latest sha256:old true", json.dumps(labels), "cloudflare/cloudflared:latest"]
            with patch.object(updater, "command", side_effect=initial + ["cloudflared different"]):
                with self.assertRaises(RuntimeError):
                    updater.describe("fixture")
            with patch.object(updater, "command", side_effect=initial + ["cloudflared expected", "running\nstopped", "running"]):
                with self.assertRaises(RuntimeError):
                    updater.describe("fixture")


if __name__ == "__main__":
    unittest.main()
