# Trellis deployment

Systemd units for running Trellis continuously on a host that already has an
onboarded openclaw setup (prod mode). Designed for a co-located deployment
on the same VM as the openclaw gateway.

## Install

```bash
sudo cp /opt/trellis/deploy/systemd/trellis-loop.service /etc/systemd/system/
sudo cp /opt/trellis/deploy/systemd/trellis-serve.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trellis-loop.service trellis-serve.service
```

## Operate

```bash
sudo systemctl status trellis-loop trellis-serve
sudo journalctl -u trellis-loop -f         # live logs
tail -f /mnt/disks/data/trellis/logs/trellis-loop.systemd.log
```

## Stop / restart

```bash
sudo systemctl stop trellis-loop                    # graceful
sudo systemctl restart trellis-loop                 # graceful restart
sudo systemctl kill --signal=SIGINT trellis-loop    # ask current iteration to drain
```

## Pre-reqs (already installed by the provisioning steps)

- Node 22 (`node --version` ≥ 22.16)
- pnpm via corepack
- openclaw installed globally via `npm install -g openclaw@<version>`
- `/opt/trellis` cloned with deps installed (`pnpm install` + `pnpm approve-builds --all`)
- `/opt/trellis/.env` populated with prod-mode env (see repo root `.env.example`)
- Persistent dirs writable under `/mnt/disks/data/trellis/`
- `/home/node` symlink to the openclaw user's home (so workspace path in `openclaw.json` resolves)
