# Local Development Stream

This worktree is the local integration branch that carries site-specific changes on top of upstream OpenClaw.

## Remotes

- `origin`: upstream OpenClaw, fetch only
- `fork`: personal fork, fetch and push

Pushes to `origin` are disabled on purpose to avoid accidental pushes to upstream.

## Branch Roles

- `origin/main`: upstream base branch
- `fork/local/devstream`: published integration branch
- `local/guard-mode-fence-wip`: snapshot of current local feature work
- `local/devstream`: local integration branch for site-specific changes on top of upstream

## Current Layout

- main repo: `/home/scott/dev/openclaw`
- integration worktree: `/home/scott/dev/openclaw-devstream`

## Update Workflow

1. Fetch upstream:

```bash
git -C /home/scott/dev/openclaw fetch origin main
```

2. Update the integration branch:

```bash
git -C /home/scott/dev/openclaw-devstream checkout local/devstream
git -C /home/scott/dev/openclaw-devstream rebase origin/main
```

If rebase is awkward for a larger local patch stack, merge `origin/main` instead.

3. Merge or cherry-pick local feature branches into the integration branch:

```bash
git -C /home/scott/dev/openclaw-devstream merge --no-ff local/<feature-branch>
```

4. Publish the updated integration branch:

```bash
git -C /home/scott/dev/openclaw-devstream push
```

`local/devstream` tracks `fork/local/devstream`, so a plain `git push` is enough.

5. Keep local-only changes small and isolated. Prefer one branch per feature so individual changes can be proposed upstream or carried locally without dragging unrelated work forward.

## Notes

- PRs should be opened from `fork/local/devstream` or from smaller feature branches pushed to `fork`.
- If a local-only branch becomes upstreamable, branch it from `origin/main` or rebase it there before opening the PR to avoid dragging unrelated local patches into review.
