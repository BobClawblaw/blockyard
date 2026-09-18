# Packaging BlockYard for the Umbrel App Store

Everything the store PR needs, kept here until it is ready to be copied into a fork of
[getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps). Nothing in here is used
by a normal `npm start` install; the repository is the source, this directory is the wrapper.

## What is where

| Path | Goes into the store PR | What it is |
| --- | --- | --- |
| `umbrel/blockyard/umbrel-app.yml` | yes | the app manifest |
| `umbrel/blockyard/docker-compose.yml` | yes | app_proxy + the app, image pinned by digest |
| `umbrel/blockyard/data/.gitkeep` | yes | the committed placeholder for the writable volume |
| `umbrel/Dockerfile` | no | builds the image the compose file names |
| `umbrel/entrypoint.js` | no | renders `local.json` from the node's env, then starts the server |
| `umbrel/local.json.template` | no | that config, with `${VAR}` holes |
| `.dockerignore` (repo root) | no | keeps `data/`, `worklog/` and any `config/local.json` out of the image |
| `.github/workflows/publish-umbrel-image.yml` | no | the multi-arch GHCR build |

The store forbids `build:` in a compose file, so the image must exist on a public registry,
multi-arch and pinned by digest, **before** the PR is opened. That is the only ordering
constraint in the whole package.

## The shape: RPC + a read-only datadir

The app takes the node's RPC (user/password from the Umbrel `bitcoin` app's exports) and
mounts the node's data directory read-only at `/var/lib/bitcoind`. The mount is what makes
the address index possible — `scripts/index-build.js` reads `<datadir>/blocks` directly.
Four apps already in the store mount the datadir `:ro` (electrs, ordinals,
ride-the-lightning, sv2-ui), so the pattern is not novel.

Without the mount BlockYard still runs: a node with `addressIndex` set and no `datadir`
logs a warning and serves RPC-only (`server/main.js`). The mount is an upgrade, not a
dependency.

## Build and publish the image

The box this was written on has Docker but no buildx and no socket permission, so the
multi-arch build happens in GitHub Actions:

```
gh workflow run publish-umbrel-image.yml -f version=0.1.2
```

It pushes `ghcr.io/<owner>/blockyard:<version>` for `linux/amd64` and `linux/arm64` and
prints the manifest digest. Put that digest in the `image:` line of
`umbrel/blockyard/docker-compose.yml` — the store linter (`--check-images`) requires it.

To build a single-arch image locally instead:

```
docker build -f umbrel/Dockerfile -t blockyard:dev .
```

## Submit

1. Image built, pushed public, digest pinned in the compose file.
2. `cp -r umbrel/blockyard <fork>/blockyard` and run `npm run lint:apps -- blockyard --check-images`
   in the fork.
3. Install it on a real Umbrel: sign in with the password Umbrel displays, restart the app,
   confirm `local.json`, the users file and the index directory all survived.
4. Open the PR with screenshots and a logo in the body. The Umbrel team adds the icon and
   gallery images before merging.

## The Diversions ship

The image carries `games/` — shareware DOOM, Quake and Wolfenstein 3D, 26 MB — exactly as
this repository does. Each is shareware whose terms allow free electronic redistribution of
the package as a whole, and each directory is copied entire, so the terms travel with the
software: Quake's `SLICNSE.TXT` §6 makes that an explicit condition ("so long as this
Agreement accompanies the Software at all times"), and it is met.

Two things to know before the PR:

- **The DOOM and Wolfenstein copies in this repository carry no licence text.** Quake's
  does. id's `LICENSE.DOC`/`VENDOR.DOC` and Apogee's `VENDOR.DOC` were in the original
  archives and are missing from ours. That is worth fixing in the repository itself,
  independently of Umbrel, since the repository redistributes them too.
- **A store reviewer will notice** that a Bitcoin node monitor's image contains `DOOM.EXE`.
  It is a headline feature of the app rather than a stowaway (see the README), so the PR
  body should say so plainly rather than let it be discovered.

## Two other things a reviewer will ask about

**The address index is expensive.** A full mainnet index is ~124 GB written, ~2.5 GB of RAM
per worker, up to four workers. On a Raspberry Pi with an SD card that is not something to
start unasked, so the shipped config sets `addressIndexBuild: "manual"` and the description
says the explorer's address search needs it built first. The server builds a missing index
by itself only when that setting is absent.

**Port 21010, not 21000.** The host-facing port in the manifest has to be unique across the
store and `datum` already publishes 21000. The container still listens on 21000 internally —
internal ports are not required to be unique, and app_proxy fronts it.
