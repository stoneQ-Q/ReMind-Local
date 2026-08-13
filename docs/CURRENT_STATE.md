# ReMind current state

> This is the single current checkpoint for starting a new ReMind task.
> Last verified: 2026-08-13, Asia/Shanghai.

## Source authority

- Authoritative checkout: `/Users/stone/Documents/remind`
- Authoritative branch: `main`
- Current continuity checkpoint: `3341dc4`
- The 59 commits that had accumulated on `codex/stage7-cloud-health-baseline`
  were fast-forwarded into `main` on 2026-08-11. The current main worktree was
  clean immediately after that operation.
- The formerly uncommitted main-worktree changes were preserved without loss on
  branch `codex/preserve-main-20260811` at commit `6d71fbc`. They are not part of
  the authoritative baseline and must be audited before selected changes are
  merged back.
- `/Users/stone/.codex/worktrees/a91a/remind` is an inactive secondary worktree.
  Do not develop, deploy, or install services from it while `main` is authoritative.

Always verify the live HEAD because it can advance after this file is updated.

## App variants, runtime modes, and development environment

Do not use the words "version", "mode", and "development build" as if they
describe the same layer. The current project has two installable app variants,
two runtime modes inside the personal test app, and one development environment.

### Installable app variants

1. Personal test app: `ReMind`
   - Android package: `app.remind.notes`
   - Current phone-verified delivery: version `1.0.2`, build 31
   - Current device: Redmi Note 13 Pro, Android 16
   - This app can expose both cloud and local runtime modes when both service
     addresses are included in its build configuration.
   - The `preview` and `preview-local` EAS profile names refer to internal build
     profiles for this same personal test app. `preview-local` is not the separate
     public `ReMind Local` product.

2. Public local self-hosted app: `ReMind Local`
   - Android package: `app.remind.notes.local`
   - Planned/configured version: `1.0.3` preview
   - EAS profile: `public-local`
   - It can be installed alongside the personal test app because it has a separate
     package identifier.
   - It does not embed the maintainer's private cloud or LAN service addresses.
     Each user connects their own Mac and uses their own API keys.
   - The repository contains its build configuration and release documentation,
     but this checkpoint has no evidence that the public preview has been formally
     released or installed on the current phone.

The repository also has a generic `production` EAS profile, but there is no
verified store or production release. Do not count it as a third delivered app.

### Runtime modes in the personal test app

1. Cloud mode
   - Uses the hosted ReMind API and cloud account.
   - Cloud Worker owns WeChat polling, link processing, and the cloud capture path.
   - This is the mode currently used on the build-31 personal test app.

2. Local mode
   - Connects to a Mac-hosted ReMind service on the same LAN.
   - Uses the local Worker and, only when local WeChat is intentionally active,
     the local gateway.
   - Local and cloud data stores are distinct; switching modes does not imply full
     bidirectional migration or synchronization.

### Development environment

- Expo/Metro (`npm start`, Expo Go where applicable, or a development build) is a
  code-development and debugging path, not a third user-facing app product.
- Development source behavior must not be described as installed-phone behavior
  until a signed APK is built, installed, and explicitly verified.

Short classification: **2 installable app variants, 2 runtime modes in the
personal test app, and 1 development environment.**

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

## Pending development changes

- The authoritative `main` development source contains a pending-release fix for
  cloud WeChat pullback: repeated cloud captures no longer count as newly
  imported notes, and overlapping refresh/interval sync attempts share one
  active database sync instead of starting competing SQLite transactions.
- This fix is development-source only. It has not been deployed to the cloud or
  included in a signed APK, so the installed personal test app remains build 31.
- Verification on 2026-08-13: TypeScript passed, all 232 tests in 62 test files
  passed, and an Android Expo export completed successfully.
- Keep this fix with the next development feature batch and produce a new APK
  only after that combined batch is tested.
- The same pending development batch separates Xiaoyuzhou system organization
  instructions from the user's saved intent. The intent field now asks for a
  complete personal reason or future use, may remain empty, and no longer shows
  the internal AI prompt as user-authored text. Schema v18 removes only known
  historical system prompts from Xiaoyuzhou `user_context` values.
- The cloud Xiaoyuzhou Paraformer pipeline was confirmed enabled on 2026-08-13;
  public free episodes can be transcribed, subject to the existing provider and
  page-access constraints. The intent separation passed TypeScript and all 234
  tests in 62 test files; phone UI verification in Expo remains pending.
- The pending development batch also clears the transient "微信同步暂时中断"
  banner after the next successful cloud pull. This addresses stale UI state
  seen when an Expo development session switches from Wi-Fi to mobile data; it
  does not change or rebind the active cloud WeChat connection.
- Cloud pullback now compares imported payload and metadata before rewriting an
  existing local note, so unchanged large Xiaoyuzhou transcripts are skipped
  instead of being rewritten every 15 seconds. The regression coverage includes
  a large transcript fixture; verification reached 235 passing tests in 63 files.
- The next cloud/app change makes cloud WeChat pullback manifest-based and
  downloads at most five changed captures per cycle, newest first. Xiaoyuzhou
  transcript bodies stay in PostgreSQL for evidence-grounded AI organization;
  mobile capture responses contain only a readiness marker, not the transcript.
  The legacy capture route remains available for build 31 but applies the same
  no-transcript mobile boundary.
- Cloud release `103a470` was deployed on 2026-08-13 after a recoverable
  PostgreSQL backup (`remind-pre-103a470-20260813T101628Z.dump`). Public
  readiness, API health, Worker startup, Server Whisper, and Xiaoyuzhou
  Paraformer were verified. Expo diagnostics then confirmed one new capture was
  imported and subsequent cycles imported zero duplicates without errors.
- The development source also self-repairs a partially applied local v19 schema
  by checking for `note_imports.source_updated_at` instead of trusting only
  `PRAGMA user_version`; this follow-up reached 273 passing app tests in 72 files
  and remains development-source only until the next APK is built.
- The pending development UI now filters known Xiaoyuzhou system prompts from
  every saved-intent display and from historical generated-note sections while
  preserving user-authored intent. Generated insight prose also removes internal
  `E<number>` markers and displayed timestamps; structured citations remain
  stored separately for evidence verification. Verification reached 279 app
  tests in 73 files and 173 cloud tests in 44 files.

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

- Audit `codex/preserve-main-20260811` against `main` and selectively recover only
  changes that are still needed and pass current tests.
- Add a safe cloud version endpoint that reports a non-secret release identifier.
- Add an in-app diagnostics view showing app build, active mode, cloud release,
  WeChat connection state, and last successful synchronization time.
- Keep dated handoff and migration documents as append-only history. Update this
  file whenever the current release, installed build, authoritative branch, or
  runtime topology changes.
