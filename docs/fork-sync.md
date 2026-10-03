# Keeping this fork synced with upstream

`origin` points at `git@github.com:michielappelman/cloudflare-os.git`; `upstream` is the canonical
`https://github.com/cloudflare/cloudflare-os.git`. Sync with:

```sh
pnpm upstream:sync --dry-run   # review only: pending commits and diffstat
pnpm upstream:sync             # merge, install, lint and test; leaves the merge unpushed
pnpm upstream:sync --push      # the same, then `git push origin main` once the checks pass
```

`scripts/upstream-sync.ts`:

1. Adds the `upstream` remote if it is missing.
2. Fetches `origin` and requires a clean tree on `main`, equal to `origin/main`. Push the fork's own
   changes first.
3. Fetches `upstream` and prints `git log --oneline --left-right main...upstream/main` and
   `git diff --stat main...upstream/main`. It exits here when there is nothing to merge, or with
   `--dry-run`. Read the full `git diff main...upstream/main` before merging anything non-trivial.
4. Runs `git merge --no-edit upstream/main`. Modify/delete conflicts on the
   [removed upstream workflows](#removed-upstream-workflows) are resolved by keeping the deletion.
   If no other conflict remains, the merge is committed. Otherwise the script lists the remaining
   conflicted files and stops with the merge in progress: resolve, `git commit --no-edit`, run
   `pnpm lint && pnpm test`, then push (or `git merge --abort`).
5. Runs `pnpm install --frozen-lockfile`, `pnpm lint` and `pnpm test`. `--skip-checks` skips them.
6. With `--push`, pushes `origin main`. It never force-pushes.

Merging keeps fork-specific commits in the history and avoids rewriting commits already pinned by a
deployment. For starter deployments, update the pinned `cloudflare-os` gitlink only after reviewing
the resulting fork commit and running the starter's documented checks.

Manual fallback: the same steps by hand.

```sh
git switch main && git pull --ff-only origin main
git fetch upstream
git log --oneline --left-right main...upstream/main
git merge --no-edit upstream/main
pnpm install --frozen-lockfile && pnpm lint && pnpm test
git push origin main
```

## Removed upstream workflows

The fork keeps only `.github/workflows/ci.yml`. Upstream's other workflows (Bonk, CLA, contribution
policy, PR labeling, previews and evals) need Cloudflare's secrets or only make sense on the
upstream repository, so they are deleted here, along with `.github/labeler.yml`. When upstream
changes one of them, the merge stops on a modify/delete conflict, which `pnpm upstream:sync`
resolves by keeping the deletion. By hand:

```sh
git rm .github/workflows/<file>.yml
git commit --no-edit
```
