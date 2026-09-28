# Keeping this fork synced with upstream

Keep `origin` pointed at `git@github.com:michielappelman/cloudflare-os.git` and add the canonical
repository once as `upstream`:

```sh
git remote add upstream git@github.com:cloudflare/cloudflare-os.git
```

Before syncing, commit and push the fork's changes to `origin/main`, then fetch both remotes and
review the upstream changes:

```sh
git switch main
git pull --ff-only origin main
git fetch upstream
git log --oneline --left-right main...upstream/main
git diff --stat main...upstream/main
git diff main...upstream/main
```

When the diff is reviewed, merge upstream into the fork and push the result:

```sh
git merge --no-edit upstream/main
git push origin main
```

This keeps fork-specific commits in the history and avoids rewriting commits already pinned by a
deployment. If the merge stops on conflicts, resolve and review them before committing. Do not
force-push. For starter deployments, update the pinned `cloudflare-os` gitlink only after reviewing
the resulting fork commit and running the starter's documented checks.
