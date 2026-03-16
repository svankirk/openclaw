# Local Development Stream

This worktree is the local integration branch that carries site-specific changes on top of upstream OpenClaw.

## Branch Roles

- `origin/main`: upstream OpenClaw
- `local/guard-mode-fence-wip`: snapshot of current local feature work
- `local/devstream`: integration branch for local changes on top of upstream

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

4. Keep local-only changes small and isolated. Prefer one branch per feature so individual changes can be proposed upstream or carried locally without dragging unrelated work forward.

## Notes

- A GitHub fork was not configured during setup because local GitHub authentication was unavailable.
- If you later authenticate with GitHub, add a personal fork as another remote and push `local/devstream` there for backup or PR work.
