# Cloudflared automatic updates

Cloudflared uses `cloudflare/cloudflared:latest` and `pull_policy: always` in
Compose. Other images retain their existing versions. The container's
`--no-autoupdate` flag stays: Docker updates replace images, rather than modifying
an executable inside a running container.

The host-level updater in this directory is shared by the application stacks on
`dev-apps`, `teamspeak`, and `renner-games`. It discovers only running,
Compose-managed containers whose image is exactly `cloudflare/cloudflared:latest`
(the `docker.io/` spelling is also accepted). It restores the original project,
Compose files and environment-file paths from Docker's Compose labels. Secret
values and raw Compose error output are never printed. The reconstructed service
hash must match the running container: edited Compose/environment files or an
unrecoverable shell-exported setting stop the update until the deployment is
reconciled. Replicated services and stopped siblings are refused.

Every six hours, with up to fifteen minutes of jitter, the updater pulls the
official image. It checks the security minimum, compares image IDs, and recreates
only changed Cloudflared services with `--no-deps --no-build --pull never`.
Stopped stacks remain stopped. The updater checks the replacement's image ID,
version, and registration with Cloudflare. Failures appear in the systemd journal
and make the service fail; unrelated application services are never restarted.
An automatic tunnel replacement may briefly interrupt ingress.

Install once per Docker host as root:

```sh
install -m 0755 deploy/cloudflared-autoupdate.py /usr/local/lib/renner-cloudflared-autoupdate.py
install -m 0644 deploy/renner-cloudflared-update.service /etc/systemd/system/
install -m 0644 deploy/renner-cloudflared-update.timer /etc/systemd/system/
systemctl daemon-reload
flock -n /run/lock/renner-cloudflared-update.lock python3 /usr/local/lib/renner-cloudflared-autoupdate.py --enroll
systemctl enable --now renner-cloudflared-update.timer
systemctl start renner-cloudflared-update.service
```

Inspect without mutation:

```sh
python3 /usr/local/lib/renner-cloudflared-autoupdate.py --dry-run
systemctl list-timers renner-cloudflared-update.timer
journalctl -u renner-cloudflared-update.service
```

The first timer check is ten to twenty-five minutes after boot. Manual checks use
`systemctl start renner-cloudflared-update.service`, sharing the timer's lock.
Run the offline tests with `python -m unittest discover -s deploy -p
'test_cloudflared_autoupdate.py'` in the repository's Python environment.

After an intentional application deployment or Compose/environment change, run
`flock -n /run/lock/renner-cloudflared-update.lock python3 /usr/local/lib/renner-cloudflared-autoupdate.py --enroll`.
Compose resolves shared network
namespaces into container IDs, so its runtime hash can differ from its source
hash. Enrollment records both hashes in root-only systemd state; the timer
refuses unknown hash pairs and never approves changed configuration itself.
Enrollment does not pull an image or restart a container. No credential values
are stored in that state file.

Reference: [Cloudflare's Docker update instructions](https://developers.cloudflare.com/tunnel/guides/update-cloudflared/).
