# ReMind current state

> This is the single current checkpoint for starting a new ReMind task.
> Last verified: 2026-08-17, Asia/Shanghai.

## Source authority

- Authoritative checkout: `/Users/stone/Documents/remind`
- Authoritative branch: `main`
- Current authoritative feature checkpoint before this documentation update:
  `aaa2f44`
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
- Development source after `47e68ff` no longer exposes that mode distinction
  in the consumer UI. The hosted service is an implementation detail for
  ordinary users; only `ReMind Local` keeps self-hosting controls.
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

- Managed link transcription checkpoint `aaa2f44` keeps the existing Alibaba
  Cloud Bailian `paraformer-v2` integration and makes it the default audio/video
  transcription path for ordinary managed accounts. Supported Xiaoyuzhou audio
  and Xiaohongshu video URLs are sent directly from their validated public CDN
  locations; ordinary managed media no longer falls back to the shared server
  Whisper path when Bailian pricing or configuration is unavailable.
- Server Whisper is now restricted by the private
  `REMIND_SERVER_WHISPER_USER_IDS` UUID allowlist. The current single production
  account is the only allowlisted account; its link audio/video continues to use
  server Whisper without consuming `忆粒`. BYOK users outside that allowlist use
  their own configured speech provider. The production UUID remains only in the
  private server environment and is not hardcoded in source.
- Bailian transcription reserves `忆粒` from the trusted media duration before
  provider submission, then settles from Paraformer's returned effective speech
  duration and releases the unused reservation. Migration
  `0018_managed_link_transcription.sql` generalized the prior Xiaoyuzhou task
  table, attached durable billing-job state, and added DashScope provider health.
- The consumer `忆粒与用量` page now explains that a five-minute video costs
  about 2.4 `忆粒` to transcribe and usually 3–5 after organization, while a
  one-hour Xiaoyuzhou episode costs about 28.8 to transcribe and usually 30–35
  after organization. It also states that actual transcription settles by
  effective speech duration and unused reservation is returned.
- Verification for `aaa2f44`: App and cloud TypeScript passed, the complete root
  suite passed 333 tests in 85 files, the cloud production build passed, and an
  Expo SDK 54 Android export completed at
  `/tmp/remind-managed-transcription-export`. No signed APK was generated or
  installed, as requested while the broader redesign is still being combined.

- WeChat onboarding copy checkpoint `47e68ff` removes the implementation-focused
  `不需要电脑或绑定码` statement. The consumer path now starts with `开始连接`,
  explains that tapping `开始连接微信` generates a QR code valid for ten minutes,
  and repeats that real server TTL on the QR screen before the same-phone
  screenshot instructions.
- Real-phone end-to-end re-pairing completed on 2026-08-17 after the reset below:
  the App generated a QR code, WeChat scan and confirmation succeeded, the cloud
  saved a new encrypted active connection, polling resumed, the user sent a test
  message, and the App received it. Read-only cloud verification found one active
  connection and the stored WeChat message count increased from 18 to 19. This
  verifies self-service re-pairing and post-pair capture without Codex, terminal,
  a local gateway, or a manual cloud restart on the user path.
- Verification for `47e68ff`: App TypeScript passed, all 326 tests in 84 files
  passed, and an Android Expo export completed at
  `/tmp/remind-wechat-onboarding-copy-export`. The cloud release remains
  `54841e8`; no signed APK was built or installed.

- Consumer header checkpoint `22f1877` replaces the ambiguous one-character
  `设` mark with a wider button labelled `设置`. TypeScript passed, all 326 tests
  in 84 files passed, and an Android Expo export completed at
  `/tmp/remind-settings-label-export`; no signed APK was built or installed.
- At the user's explicit request on 2026-08-17, the single production cloud
  WeChat connection was revoked so the new in-App QR pairing flow can be tested
  from its first screen. Before the mutation, a readable custom-format database
  backup was created at
  `/opt/remind/shared/backups/remind-pre-wechat-repair-test-20260817T090500Z.dump`
  (12,311,564 bytes, mode 0600, `ubuntu:ubuntu`). The transaction cancelled the
  current poll, marked the connection revoked, cleared its provider hash and
  encrypted credentials, advanced its poll generation, and removed its poll job.
- Immediate post-reset verification found zero active WeChat connections, while all 18
  existing WeChat messages and the corresponding 18 cloud notes remained. Public
  readiness stayed healthy on cloud release `54841e8`. The local gateway was not
  started. The fresh real-phone QR scan and post-connection capture were then
  completed successfully as recorded above.

- Consumer clarity checkpoint `f00ba85` renames `智能整理` settings to
  `智能功能` and defines three separate concepts: organizing one record into a
  reviewable note, asking ReMind across existing records with sources, and
  choosing the automation applied after link content is retrieved. Asking
  ReMind is not presented as part of organization, and the link options are
  explicitly scoped to link automation rather than ordinary text or Q&A.
- The consumer copy no longer promises later image, audio, or video intelligence.
  Link choices are now `先预览再保存`, `自动保存为笔记`, and
  `自动保存并归类`. The connected-WeChat screen explains that the user sends
  text or forwards supported public links to the assistant chat created during
  connection; ReMind saves the original first, then applies the selected link
  handling mode and syncs it into the App.
- Verification for `f00ba85` on 2026-08-17: App TypeScript passed, all 326 tests
  in 84 files passed, and an Android Expo export completed successfully at
  `/tmp/remind-intelligence-wechat-clarity-export`. No cloud deployment, signed
  APK build, phone installation, or local gateway start occurred.

- Consumer settings checkpoint `cd72f3d` consolidates the ordinary ReMind home
  header to one `设置` entry. WeChat connection, intelligent organization,
  `忆粒与用量`, and the Obsidian note library now live directly inside settings;
  the redundant top-level `微` and `库` entries remain available only in
  `ReMind Local`.
- The consumer settings sheet no longer shows the decorative readiness mark,
  the “ReMind 已经准备就绪” explanation, the cloud/local selector, or the
  `功能与使用` heading. Its short descriptions now identify only the action
  behind each row. `运行状态与诊断` remains visible in Expo/development through
  `__DEV__`, stays available in `ReMind Local`, and is hidden from production
  consumer builds.
- Verification for `cd72f3d` on 2026-08-17: App TypeScript passed, all 326 tests
  in 84 files passed, and an Android Expo export completed successfully at
  `/tmp/remind-settings-consolidation-export`. This is source/export validation,
  not a signed APK build or phone installation. The deployed cloud release
  remains `54841e8`, the phone-installed signed delivery is unchanged, and the
  local gateway was not started.

- Consumer experience checkpoint `dcd859d`, with Node-24-compatible cloud lock
  follow-up `54841e8`, removes the cloud/local choice and “cloud connected”
  account details from ordinary ReMind settings. The header now opens plain
  ReMind settings, whose primary entries are WeChat, intelligent organization,
  and `忆粒`; diagnostics remains available as a help path. `ReMind Local`
  retains explicit service addresses, runtime modes, API keys, task quotes, and
  device controls.
- The same batch simplifies `忆粒` activity by collapsing a completed job's
  reserve/settle/release ledger sequence into one actual-use row while keeping
  active reservations visible. `问 ReMind` now separates the user's question,
  evidence status, answer, citations, and follow-up questions instead of placing
  them in one large answer card. The rejected legacy `灵` mark and consumer
  currency symbol were removed.
- Consumer WeChat connection now has an in-App self-service QR flow. The cloud
  requests the short-lived iLink QR, returns only a rendered QR image plus an
  authenticated encrypted session token bound to the current ReMind account,
  rate-limits creation and checks, accepts the optional WeChat verification
  number in the App, and saves protocol credentials only after WeChat confirms.
  The session expires after ten minutes and neither API responses nor logs expose
  confirmed credentials. The existing six-digit gateway binding flow remains
  for `ReMind Local`.
- Verification for this batch on 2026-08-17: App TypeScript passed, 326 tests in
  84 files passed, and an Android Expo export completed; cloud TypeScript and
  production build passed, 209 tests in 52 files passed, and production
  dependencies reported zero known vulnerabilities. A fresh-account real QR
  scan has not yet been completed because the current production test account is
  already bound; do not disturb that working connection merely to exercise the
  first-time path. The settings and already-connected WeChat screens still need
  the user's Expo visual review before a signed APK is produced.

- Authoritative `main` through commit `06e1a49` contains the first
  pass of the zero-configuration consumer experience. A clean consumer install
  prefers the hosted cloud service, creates its anonymous device account in the
  background, securely retains the one-time recovery code until acknowledged,
  and enables ReMind-managed AI without asking the user for a provider or API
  key. The consumer settings describe managed intelligence, privacy, trial
  credit, and usage; BYOK fields and local service addresses remain available
  only in the explicit `ReMind Local` build variant.
- The same source checkpoint extends managed AI to synchronous and durable text
  organization. New managed accounts may receive an operator-configured starter
  credit, text calls reserve a server-priced upper bound before contacting the
  provider, settle from provider token usage, and release the reservation on
  failure. Public enablement is fail-closed behind
  `REMIND_CONSUMER_MANAGED_AI_ENABLED`; the starter credit, platform DeepSeek
  credential, price table, and existing cost limits must all be explicitly
  configured. No payment entry point was opened.
- The managed rollout is now intentionally split: DeepSeek-backed text
  organization and memory Q&A can be enabled while media remains in BYOK mode.
  Consumer-managed text requires only the platform DeepSeek credential and the
  two DeepSeek text rates; it does not implicitly enable managed image, audio,
  or video processing.
- Consumer-facing usage is branded as `忆粒`, not currency or generic points.
  One `忆粒` is a presentation unit over the existing integer server ledger;
  consumer screens show grants, holds, usage, returns, and safety limits only in
  `忆粒`. ReMind Local continues to show provider costs directly for self-hosters.
- The user authorized the single-account private test to reuse the account's
  existing encrypted DeepSeek credential as the temporary platform credential.
  The audited bootstrap requires exactly one active account and one credential,
  never prints the secret, writes the server environment atomically with private
  permissions, and grants 200 `忆粒` through an idempotent gift-ledger entry.
- A read-only production audit on 2026-08-17 found that daily local backups and
  encrypted off-site uploads had continued through 2026-08-16. The health check
  nevertheless reported a stale backup because its filename sort selected the
  older `remind-pre-*` release backup instead of newer `remind-<timestamp>` daily
  backups. Release `06e1a49` restricts that check to daily backup filenames; the
  corrected health check is now active and passes in production.
- Verification on 2026-08-17: App and cloud TypeScript passed; all 158 App
  source tests in 40 files and all 198 cloud tests in 49 files passed (the root
  aggregate suite also passed 313 tests in 81 files); the cloud production
  build passed; Expo SDK 54 public config preserved `ReMind`
  (`app.remind.notes`) and `ReMind Local` (`app.remind.notes.local`) as separate
  variants; and Android Expo exports completed successfully for both variants.
  Their unminified bundles were also verified to differ at the compile-time app
  boundary. The cloud portion is deployed as described below. The consumer App
  UI has not been built as a signed APK, installed, or phone-verified; build 31
  remains the installed delivery.

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
- Development commit `6004964` adds one in-app diagnostics view for the app
  version/build, Expo or installed environment, active cloud/local mode, public
  cloud release identifier, WeChat connection, last successful phone pull, and
  the latest stored synchronization error. The cloud `/ready` response now
  exposes only the safe release identifier, never secrets or credentials.
- The same development batch moves cloud link insight generation into a durable
  server job. The phone persists the job identifier locally, may leave the page
  or close the App, and resumes result collection after reopening. Existing
  Xiaoyuzhou or video transcript evidence is reused by the organization job; the
  organization retry path does not enqueue transcription again. Local mode keeps
  the existing foreground organization route.
- Note cards now reserve their first visible pill for the information source,
  including Xiaoyuzhou, Xiaohongshu, WeChat Official Accounts, Bilibili,
  YouTube, WeChat, system share, or self-authored records. At most one AI topic
  tag follows it, so source and model-generated topic are not conflated.
- Verification for commit `6004964`: App TypeScript passed, 287 tests in 76 test
  files passed, cloud TypeScript and production build passed, 176 cloud tests in
  45 files passed, and an Android Expo export completed successfully. The app
  UI and database schema v20 remain development-source only and are not installed
  as a signed APK; build 31 remains the phone-installed delivery.
- Expo real-phone verification on 2026-08-13 confirmed the diagnostics page
  reported cloud release `6004964`, the WeChat gateway online, and a concrete
  last-sync time. Note-card source pills were also confirmed on the phone.
  Diagnostics exposed one remaining manifest-loop issue: semantically identical
  timestamps such as `...Z` and `...000Z` compared unequal, and an unchanged
  capture could return before persisting its source version. Commits `92c8e2e`
  and `94e1fa0` fixed both cases; the live Expo log then converged from one
  final pending capture to repeated `pending 0 / imported 0` cycles.
- The durable background-insight close/reopen phone scenario was intentionally
  deferred by the user. Automated coverage and cloud deployment are complete,
  but do not record that specific interaction as phone-verified yet.
- Personal cloud test APK ReMind `1.0.2`, Android build 33, package
  `app.remind.notes`, completed successfully in GitHub Actions on 2026-08-13.
  Workflow run `31697617120` built remote commit `be96768` from branch
  `cloud-build-33`, verified the APK archive, generated its SHA-256 file, and
  uploaded artifact `ReMind-1.0.2-build33-diagnostics-background-insights`
  (GitHub artifact ID `9180172967`, retained for 14 days). This is a completed
  signed build but is not yet installed or phone-verified; build 31 remains the
  delivery currently verified on the Redmi.

## Cloud mode

- Cloud mode, cloud account recovery, cloud WeChat binding and polling, BYOK, link
  processing, and phone pullback have already completed end-to-end verification.
- Public readiness endpoint:
  `https://remind.43-129-237-189.sslip.io/ready`
- On 2026-08-11 the endpoint returned HTTP 200 with the database ready.
- The readiness response exposes a safe release identifier. Continue to verify it
  directly because repository HEAD, installed App build, and cloud release can
  advance independently.
- Last documented phone verification before later source work was build 31.
- Cloud release `6004964` was deployed on 2026-08-13 after recoverable backup
  `remind-pre-6004964-20260813T111902Z.dump`. PostgreSQL, migration, API, Worker,
  Caddy, Whisper, and public readiness were healthy; `/ready` reported release
  `6004964`, the Worker reported server Whisper and Xiaoyuzhou Paraformer enabled,
  and existing user/note counts remained present. The local Mac gateway remained
  unloaded during deployment.
- Cloud release `06e1a49` was deployed on 2026-08-17 from a committed Git
  archive after verified custom-format backup
  `remind-pre-06e1a49-20260817T040452Z.dump` (12,167,983 bytes, mode 0600).
  PostgreSQL migration, API, Worker, backup, Caddy, Whisper, public readiness,
  and the corrected backup health check passed. The restarted backup service
  also created and uploaded encrypted backup
  `remind-20260817T040708Z.dump.enc`.
- The user-authorized single-account bootstrap reused the existing encrypted
  DeepSeek credential without printing it, enabled managed text while keeping
  media in BYOK mode, and granted 200 `忆粒` through one gift-ledger entry. The
  account is `managed`, has no reserved usage, and both API and Worker loaded the
  managed configuration successfully. The prior private environment remains at
  `/opt/remind/shared/remind.env.pre-06e1a49` with mode 0600 for emergency
  rollback; the active environment remains mode 0600 and `ubuntu:ubuntu`.
- Expo real-phone verification on 2026-08-17 completed the authenticated
  phone-to-managed-DeepSeek billing path for `问 ReMind`. The visible response
  correctly reported that there was not enough direct evidence for “loop
  engineering”, separated potentially related saved material from direct facts,
  and offered evidence-grounded follow-up questions. The corresponding
  `ai.text` job succeeded with DeepSeek: 114,880 micros were reserved, 10,247
  micros were settled (about 1.02 `忆粒`), the unused 104,633 micros were
  released, reserved usage returned to zero, and the account balance became
  1,989,753 micros (displayed as 198.98 `忆粒`). Public readiness still reported
  release `06e1a49`, and the server health check passed. This verifies the live
  Expo development session, not a newly signed or installed APK; build 31
  remains the phone-installed delivery.
- Cloud release `54841e8` was deployed on 2026-08-17 after verified custom-format
  backup `remind-pre-54841e8-20260817T082520Z.dump` (12,293,455 bytes, mode
  0600). The first build attempt from `dcd859d` stopped before symlink switching
  because the Node 24 container rejected an incomplete optional-dependency lock;
  `54841e8` regenerated that lock with the server npm version and then deployed
  successfully. API, Worker, backup, Caddy, PostgreSQL, Whisper, public readiness,
  and the health check passed; `/ready` reported `54841e8`. The self-service
  WeChat endpoint rejects unauthenticated requests, its QR runtime dependency
  loaded in the production API container, the existing managed account remained
  at 1,989,753 micros with zero reserved usage, and the existing cloud WeChat
  connection remained online. No local gateway was started.
- Cloud release `aaa2f44` was deployed on 2026-08-17 from the committed source
  after verified custom-format PostgreSQL backup
  `remind-pre-aaa2f44-20260817T101123Z.dump` (12,326,488 bytes, mode 0600) and
  private environment backup
  `remind.env.pre-aaa2f44-20260817T101123Z` (mode 0600). Migration 0018 applied,
  public readiness reported `aaa2f44`, the health check passed, DashScope provider
  health was active, and the Worker loaded one Whisper-allowlisted account plus
  the Bailian price and credentials without exposing their values.
- Post-deployment checks confirmed the production routing artifact selects
  `whisper` for the allowlisted account and `dashscope` for an ordinary managed
  account. The existing account balance remained 1,989,753 micros with zero
  reserved usage, one cloud WeChat connection remained active, and the stored
  WeChat note count remained 19. No synthetic ordinary account or billable media
  task was created solely for deployment testing; the first real ordinary-user
  transcription still needs end-to-end ledger observation. The Mac local gateway
  remained unloaded.

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
- Complete real-phone validation for the `6004964` development batch across
  Wi-Fi/mobile-data switches, background/force-close recovery, and durable
  Xiaoyuzhou insight completion after build 33 is installed.
- Keep dated handoff and migration documents as append-only history. Update this
  file whenever the current release, installed build, authoritative branch, or
  runtime topology changes.
