# Daily Digital Twin

[中文说明](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Operations runbook](docs/RUNBOOK.md) · [Browser profiles](docs/BROWSER-PROFILES.md)

A privacy-first local task runtime for Windows, Feishu, browser automation, and controlled desktop execution. A phone can submit a task through Feishu; a remote model may propose a plan; the local runtime reviews policy, executes through configured adapters, and requires observable evidence before reporting completion.

The source code is public. Runtime state, credentials, browser sessions, screenshots, logs, personal files, and machine-specific application paths remain in a required private directory outside the repository.

## Engineering evidence

- **132 Node unit tests** covering task state, scheduling, identity binding, resource locks, redaction, evidence verification, and related invariants
- **CI on Linux and Windows** with Node 24, privacy auditing, CLI smoke tests, PowerShell parsing, encoding checks, and platform self-tests
- **Zero third-party runtime dependencies**; the runtime uses Node standard-library components, including `node:sqlite` and `node:test`
- **Fail-closed resource policy**: missing or invalid telemetry produces zero execution slots rather than permissive defaults
- **Evidence-gated completion**: a task without valid process, window, page, or file evidence is downgraded to `partial`
- **Human confirmation boundaries** for deletion, overwrite, upload, payment, messaging, and public posting

## Safety boundaries

This project is intentionally conservative because it can interact with signed-in browser sessions and local applications.

- The remote model is a planning component, not a trusted executor.
- The scheduler is disabled by default and must be enabled explicitly.
- CAPTCHA prompts, login dialogs, and tasks requiring human judgement pause for intervention.
- Verification codes are passed only to the active page; they are not stored in receipts.
- The first Feishu sender becomes the bound owner; later senders are rejected until a local reset.
- Desktop automation is foreground-exclusive, and resources such as applications, files, and tabs are locked against conflicting tasks.
- Secrets and personal paths are rejected by a repository privacy audit that also runs in CI.

These controls reduce risk; they do not make unattended browser or desktop automation universally safe. Review the configuration and threat model before connecting real accounts.

## Architecture

```text
phone / Feishu          remote model                 Windows machine
      |                      |                              |
      | task text            | untrusted plan               |
      +--------------------->+----------------------------->|
                             |                              | policy review
                             |                              | controlled execution
                             |                              | evidence verification
                             |<-----------------------------+
                                  redacted receipt
```

```text
src/core/            task state, policy, routing, redaction, verification, AI planner, AI executor
src/runtime.mjs      command-line entry point
platform/windows/    setup, telemetry, backup, repair, and self-test scripts
config/*.example.*   sanitised example configuration
scripts/             privacy and source audits
test/                Node test suite
docs/                architecture, operations, browser routing, and bug-fix record
```

Private state lives under `DAILY_TWIN_HOME`. There is no repository-local fallback: the CLI exits with an error when the private home is not configured.

## Requirements

- Windows 11 for the intended deployment environment
- Node.js 24 or newer
- PowerShell for platform setup, telemetry, and Windows self-tests
- A separately configured compatible model endpoint for planning
- Explicitly configured browser and application adapters for real execution

No `npm install` step is required because the project declares no runtime or development dependencies.

## Quick start

Set up the private state directory from PowerShell:

```powershell
.\platform\windows\Set-DailyTwinPaths.ps1 -PrivateHome 'D:\DailyTwin\home'
$env:DAILY_TWIN_HOME = 'D:\DailyTwin\home'
```

Initialise the runtime and inspect its state:

```powershell
npm run runtime -- init
npm run runtime -- create 'Open the configured research workspace and enter TEST_TEXT'
npm run runtime -- status
npm run runtime -- doctor
```

The scheduler remains dormant after installation:

```powershell
npm run runtime -- scheduler status
npm run runtime -- scheduler enable
```

### Morning workflow (v3)

Send all your tasks at once — the AI planner decomposes them into sub-tasks, creates a parent-child task tree, and optionally starts the scheduler:

```powershell
# Create a task file (one task per line, # for comments)
npm run runtime -- morning C:\path\to\tasks.txt --enable
```

Batch import without AI planning:

```powershell
npm run runtime -- batch C:\path\to\tasks.txt
```

Configure the AI API in your private `config/runtime.json` (see `config/runtime.example.json`). Without an API configured, tasks pass through as `unknown` type without decomposition.

Read [`docs/RUNBOOK.md`](docs/RUNBOOK.md) before enabling routine execution. Browser-profile behaviour and unattended-operation constraints are documented in [`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md).

## Verification

Run the cross-platform checks before committing:

```bash
npm test
npm run audit:privacy
npm run smoke
npm run check
```

Windows adds PowerShell-specific checks:

```powershell
npm run lint:ps
npm run selftest:ps
```

`npm run check` combines the Node tests, privacy audit, and CLI smoke test. CI also verifies that the project remains dependency-free and that Windows scripts retain the encoding and line-ending properties required by Windows PowerShell 5.1.

## Status and limitations

| Component | Status | Important limitation |
| --- | --- | --- |
| Core task store and policy | Tested | Designed for one owner on one Windows machine |
| Privacy audit and redaction | CI-enforced | Cannot compensate for secrets deliberately committed outside the audited patterns |
| Scheduler | Dormant by default | Requires fresh CPU and power telemetry before accepting work |
| Browser routing | Documented and guarded | Some profiles require a human or a separate initial login |
| Built-in executor | AI executor for `ai_call` tasks | `desktop`/`browser` types return `partial`; real machine-specific execution must be configured privately |
| AI planner | Tested | Decomposes tasks via OpenAI-compatible API; falls back to passthrough when unconfigured |
| Morning workflow | Tested | Batch import → AI planning → sub-task creation → optional scheduler start |
| Destructive or external actions | Confirmation-gated | Human approval remains part of the security model |

The repository is an experimental personal automation framework, not a general-purpose autonomous agent or a security-certified product.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — trust model, state, scheduling, verification, and design trade-offs
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — setup and operations
- [`docs/BROWSER-PROFILES.md`](docs/BROWSER-PROFILES.md) — browser routes, requirements, and unattended-operation limits
- [`docs/BUGFIX-LOG.md`](docs/BUGFIX-LOG.md) — defects, fixes, and the tests that guard them
- [`README.zh-CN.md`](README.zh-CN.md) — the preserved original Chinese landing page

## Licence

MIT. See [`LICENSE`](LICENSE).
