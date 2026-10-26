#!/usr/bin/env python3
"""Refresh only running Compose-managed Cloudflared containers using :latest."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time

IMAGES = {"cloudflare/cloudflared:latest", "docker.io/cloudflare/cloudflared:latest"}
MINIMUM_VERSION = (2026, 10, 3)


def command(args, *, cwd=None, timeout=180):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # Compose may echo interpolated configuration in errors. Never forward it.
        raise RuntimeError(f"{args[0]} operation failed (exit {result.returncode})")
    return result.stdout.strip()


def describe(container):
    fields = command(["docker", "inspect", "--format", "{{.Config.Image}} {{.Image}} {{.State.Running}}", container]).split()
    if len(fields) != 3 or fields[0] not in IMAGES or fields[2] != "true":
        return None
    labels = json.loads(command(["docker", "inspect", "--format", "{{json .Config.Labels}}", container])) or {}
    prefix = "com.docker.compose.project"
    project, cwd = labels.get(prefix), labels.get(prefix + ".working_dir")
    service = labels.get("com.docker.compose.service")
    files = labels.get(prefix + ".config_files", "").split(",")
    if not project or not service or not cwd or not Path(cwd).is_dir():
        raise RuntimeError("Cloudflared is missing valid Compose project metadata")
    args = ["docker", "compose", "--project-name", project, "--project-directory", cwd]
    for env in filter(None, labels.get(prefix + ".environment_file", "").split(",")):
        if not Path(env).is_file():
            raise RuntimeError("Compose environment file is unavailable")
        args.extend(["--env-file", env])
    for file in files:
        if not Path(file).is_file():
            raise RuntimeError("Compose configuration file is unavailable")
        args.extend(["-f", file])
    configured = command([*args, "config", "--images", service], cwd=cwd)
    # `config --images SERVICE` also lists that service's dependencies. The
    # service hash below binds the selected service to its running config.
    if fields[0] not in configured.splitlines():
        raise RuntimeError("Compose service no longer selects the expected Cloudflared image")
    config_hash = command([*args, "config", "--hash", service], cwd=cwd).split()
    if len(config_hash) != 2 or config_hash[0] != service or config_hash[1] != labels.get("com.docker.compose.config-hash"):
        raise RuntimeError("Compose service configuration differs from the running deployment")
    siblings = command(["docker", "ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + project,
                        "--filter", "label=com.docker.compose.service=" + service]).splitlines()
    full_id = command(["docker", "inspect", "--format", "{{.Id}}", container])
    if siblings != [full_id]:
        raise RuntimeError("Automatic updates require exactly one container per Cloudflared service")
    return {"id": container, "project": project, "service": service, "cwd": cwd,
            "compose": args, "image": fields[0], "running_image": fields[1]}


def verify_version(output):
    match = re.search(r"\b(\d{4})\.(\d+)\.(\d+)\b", output)
    if not match or tuple(map(int, match.groups())) < MINIMUM_VERSION:
        raise RuntimeError("Cloudflared image does not meet the patched minimum version")


def refresh(target, *, dry_run=False):
    name = target["project"] + "/" + target["service"]
    if dry_run:
        print(name + ": eligible; Cloudflared only; no dependencies or stopped services", flush=True)
        return
    desired = command(["docker", "image", "inspect", "--format", "{{.Id}}", target["image"]])
    if desired == target["running_image"]:
        print(name + ": current; no restart", flush=True)
        return
    # Refuse to apply a stale container snapshot after another deployment changes it.
    if describe(target["id"]) != target:
        raise RuntimeError("Deployment changed during update; retry on the next scheduled run")
    command([*target["compose"], "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--scale", target["service"] + "=1", target["service"]], cwd=target["cwd"])
    ids = command([*target["compose"], "ps", "-q", target["service"]], cwd=target["cwd"]).splitlines()
    if len(ids) != 1:
        raise RuntimeError("Expected one running replacement Cloudflared container")
    container = ids[0]
    actual = command(["docker", "inspect", "--format", "{{.Image}}", container])
    if actual != desired:
        raise RuntimeError("Replacement container does not use the downloaded image")
    verify_version(command(["docker", "exec", container, "cloudflared", "--version"]))
    ready_checks = 0
    for _ in range(30):
        result = subprocess.run(["docker", "logs", "--since", "2m", container], text=True, capture_output=True, timeout=30)
        state = command(["docker", "inspect", "--format", "{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container])
        ready_checks = ready_checks + 1 if state in ("true none", "true healthy") and result.returncode == 0 and "Registered tunnel connection" in result.stdout + result.stderr else 0
        if ready_checks >= 2:
            print(name + ": updated; tunnel connected", flush=True)
            return
        time.sleep(2)
    raise RuntimeError("Replacement Cloudflared did not register a tunnel connection within 60 seconds")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    targets = []
    failed = False
    for container in command(["docker", "ps", "-q"]).splitlines():
        try:
            target = describe(container)
            if target:
                targets.append(target)
        except (RuntimeError, subprocess.SubprocessError, OSError, ValueError):
            print("Cloudflared discovery failed; check Compose metadata locally", flush=True)
            failed = True
    if not args.dry_run:
        for image in sorted({target["image"] for target in targets}):
            command(["docker", "pull", image], timeout=300)
            verify_version(command(["docker", "run", "--rm", "--network", "none", image, "--version"]))
    for target in targets:
        try:
            refresh(target, dry_run=args.dry_run)
        except (RuntimeError, subprocess.SubprocessError, OSError, ValueError):
            print(target["project"] + ": Cloudflared update failed; inspect service locally", flush=True)
            failed = True
    print(f"Cloudflared updater: {len(targets)} eligible running services", flush=True)
    return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError):
        print("Cloudflared updater failed; inspect Docker and network availability locally", flush=True)
        raise SystemExit(1)
