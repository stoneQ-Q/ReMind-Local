# ReMind current state

> This is the single current checkpoint for starting a new ReMind task.
> Last verified: 2026-08-11, Asia/Shanghai.

## Source authority

- Authoritative checkout: `/Users/stone/.codex/worktrees/a91a/remind`
- Authoritative branch: `codex/stage7-cloud-health-baseline`
- Verified baseline before this checkpoint: `8826ef9`
- The checkout was clean at `8826ef9` and was 59 commits ahead of `main`.
- `/Users/stone/Documents/remind` on `main` is not authoritative. Its committed
  baseline is `1e9cb31` from 2026-07-31 and it currently contains a separate set
  of uncommitted changes. Preserve those changes and do not develop, deploy, or
  install services from that checkout until they have been reconciled explicitly.

Always verify the live HEAD because it can advance after this file is updated.

## Installed app and source after it

- Last documented and phone-verified delivery: ReMind `1.0.2`, Android build 31.
- Device: Redmi Note 13 Pro, Android 16.
- APK: `/Users/stone/Downloads/ReMind-1.0.2-build31-photo-layout-fix.apk`
- Build 31 completed the real Android photo-preview regression and preserved the
  cloud account, WeChat connection, BYOK configuration, and local records.
- The authoritative source contains later Xiaoyuzhou work through `8826ef9` and a
  workflow intended to create build 32. No build-32 APK is present in Downloads,
  and this checkpoint has no evidence that build 32 was installed on the phone.
  Do not describe post-build-31 source changes as phone-delivered without a new
  build and explicit installation verification.

## Cloud mode

- Cloud mode, cloud account recovery, cloud WeChat binding and polling, BYOK, link
  processing, and phone pullback have already completed end-to-end verification.
- Public readiness endpoint:
  `https://remind.43-129-237-189.sslip.io/ready`
- On 2026-08-11 the endpoint returned HTTP 200 with the database ready.
- The readiness response does not currently expose a Git release SHA, so the exact
  deployed source commit must not be inferred from repository HEAD alone.
- Last documented phone verification before later source work was build 31.

## WeChat polling safety

- The active cloud WeChat connection polls in the cloud Worker.
- The Mac's local `app.remind.gateway` must remain unloaded during cloud-mode use.
  Running it against the same WeChat account can compete for the same cursor and
  cause a message to enter local D1 instead of the cloud account.
- Preserve `~/.remind-weixin/config.json`; stopping the LaunchAgent is not a logout
  and does not delete the saved WeChat credentials.
- On 2026-08-11 a Bilibili short link was consumed by the accidentally running
  local gateway and stored in local D1. This explains why it did not appear in the
  cloud-mode phone inbox. Do not claim the cloud parser rejected that link without
  inspecting the cloud poll state first.

## Current data boundaries

- Cloud mode synchronizes new cloud WeChat captures to the phone.
- Historical SQLite records are not automatically uploaded across devices.
- Phone-generated organized notes, theme edits, ordinary local captures, and image
  originals are not yet a complete multi-device synchronization system.
- Image originals remain on the phone that created them.
- Do not clear or replace `remind.db`, SecureStore, PostgreSQL, D1, WeChat login or
  connection state, user API keys, object storage, or Obsidian authorization.

## Start-of-task checklist

Before changing anything:

1. Read this file and `AGENTS.md`.
2. Check all worktrees, the current branch, HEAD, and dirty files.
3. Check the installed app build when the task depends on phone behavior.
4. Check `/ready`; for deployment-sensitive work, verify the server release through
   deployment records until a version endpoint exists.
5. Inspect LaunchAgent executable paths before restarting local services.
6. Confirm that the local gateway is unloaded while cloud WeChat polling is active.
7. If live evidence conflicts with this file, stop and update this checkpoint from
   verified evidence before continuing feature work.

## Next engineering safeguards

- Reconcile the 59-commit authoritative branch with `main` without overwriting the
  uncommitted main-worktree changes.
- Add a safe cloud version endpoint that reports a non-secret release identifier.
- Add an in-app diagnostics view showing app build, active mode, cloud release,
  WeChat connection state, and last successful synchronization time.
- Keep dated handoff and migration documents as append-only history. Update this
  file whenever the current release, installed build, authoritative branch, or
  runtime topology changes.
