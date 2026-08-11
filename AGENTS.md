# Expo 54 project

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

## Authoritative project state

Before doing any ReMind work, read `docs/CURRENT_STATE.md` in full.

At the start of every new task:

1. Run `git status --short --branch`, `git worktree list`, and `git log -5 --oneline`.
2. Confirm that the current checkout and branch match the authority recorded in
   `docs/CURRENT_STATE.md`.
3. Distinguish source HEAD, installed Android build, deployed cloud release, and
   local background-service paths. They are separate version facts.
4. Treat dated handoff and migration documents as historical evidence, not as the
   current source of truth when they conflict with `docs/CURRENT_STATE.md` or live
   read-only checks.
5. If any version, worktree, deployment, or runtime path conflicts, stop mutations
   and report the mismatch before choosing a checkout or restarting a service.

After a build, deployment, branch change, service-path change, or completed
end-to-end verification, update `docs/CURRENT_STATE.md` in the same change.

Never run the local `app.remind.gateway` while the active cloud WeChat connection
is polling the same WeChat account. The two pollers can compete for one cursor.
