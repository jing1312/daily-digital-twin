# Architecture

A personal "digital twin": a long-running agent on a single Windows 11 laptop that accepts
natural-language tasks from a phone (via Feishu), plans them with a remote model, and executes
them locally against a real browser session and a whitelist of desktop applications.

This document explains the design constraints, the module boundaries, and — more importantly —
the failure modes the design is built to prevent. Most decisions here exist because the naive
version was tried first and broke in a specific, reproducible way.

---

## 1. Design constraints

The constraints come from the deployment target, not from taste.

| Constraint | Consequence |
|---|---|
| One consumer laptop, shared with its owner's daily work | The agent must yield resources, never monopolise them |
| Runs 24/7, unattended most of the time | Any step that requires a human at the keyboard is a design failure |
| Handles a signed-in browser session and personal files | Secrets and personal paths must never reach a public repository or a remote model |
| The public repository is on GitHub; the runtime data is not | Hard separation between code and state, enforced mechanically |
| Zero third-party runtime dependencies | Only the Node standard library (`node:sqlite`, `node:test`) and PowerShell |

The zero-dependency rule is deliberate: the supply-chain surface of an agent that can drive a
signed-in browser and launch executables is not a place to accept transitive packages. A CI job
fails the build if `dependencies` or `devDependencies` becomes non-empty.

---

## 2. Trust model

The system splits into three planes with asymmetric trust:

```
  phone (Feishu)          remote model               local machine
       │                       │                          │
       │  task text            │  plan (untrusted)        │
       └──────────────────────>│─────────────────────────>│
                               │                          │  review → execute → verify
                               │<─────────────────────────┘
                                    redacted receipt only
```

1. **Control plane (phone).** Sends task text. Identity is bound on first contact
   (see §5).
2. **Planning plane (remote model).** Produces plans. **It is never trusted to execute.**
   It receives only redacted content.
3. **Execution plane (local).** Reviews the plan against local policy, executes, and — this is
   the part that matters — *verifies that the action actually happened* before reporting success.

The one-way redaction boundary is enforced in `src/core/redact.mjs` and re-checked at commit time
by `scripts/privacy-audit.mjs`, which imports the same rule set. Two independent copies of a
redaction rule set will drift; one shared module cannot.

---

## 3. Module map

```
src/
  runtime.mjs                 CLI entry point; the only place that touches process I/O
  core/
    home.mjs                  Resolves the private state directory. Fails closed.
    config.mjs                Defaults, validation, and file loading
    schema.mjs                SQLite schema v2 + forward migration
    task-store.mjs            Task lifecycle, concurrency slots, resource locks, ledger
    redact.mjs                Key-name and value-shape redaction
    telemetry.mjs             CPU / memory / disk / AC-power sampling
    resource-policy.mjs       Telemetry → how much work is allowed right now
    scheduler-loop.mjs        The 24/7 loop; dormant by default
    execution-verifier.mjs    Evidence requirements before a task may be "completed"
    browser-router.mjs        Which browser profile a web action may use
    feishu-adapter.mjs        Message ingress, sender authorisation
    message-router.mjs        Text → intent (new task / verification code / control command)
    runtime-command.mjs       Argv → structured command
    app-catalog.mjs           Whitelisted desktop applications and aliases
    receipt.mjs               Redacted execution receipts
    retry-policy.mjs          Bounded backoff
    token-ledger.mjs          Token accounting per task and worker
platform/windows/             11 PowerShell scripts: setup, telemetry, backup, repair, self-test
scripts/                      Privacy audit, PowerShell linter, lexical scanner
```

Roughly 2,500 lines of application code and 132 tests. The largest module (`task-store.mjs`,
495 lines) is the one holding all the invariants; everything else is deliberately small enough
to read in one sitting.

---

## 4. State: SQLite, and why the pragmas matter

State lives in a single SQLite database under a private directory outside the repository.

**Schema v2** extends v1 without data loss. `migrate()` derives the starting version as
`recorded ?? (preexistingTasks ? 1 : 0)`, so a database created before versioning was introduced
is correctly identified as v1 rather than treated as empty. The whole migration runs inside
`BEGIN IMMEDIATE` / `COMMIT` with `ROLLBACK` on failure, and is idempotent — reopening the
database does not re-migrate.

Two pragma settings are not optional:

- **`journal_mode = WAL`.** The original code left the default (`delete`), under which a second
  writer fails immediately.
- **`busy_timeout = 5000`.** The original value was `0`, i.e. "fail on the first contended write".

A useful caveat discovered while testing: `busy_timeout` does not save you from a long-held
`BEGIN IMMEDIATE`. A writer holding an immediate transaction still produces
`database is locked` after the timeout expires. The design response is *short transactions plus
a bounded application-level retry* (5 attempts, 120 ms apart), not a longer timeout.

Resource exclusion uses a single atomic statement rather than `SELECT`-then-`INSERT`, plus a
partial unique index:

```sql
CREATE UNIQUE INDEX resource_locks_one_per_class
  ON resource_locks(exclusive_class) WHERE exclusive_class IS NOT NULL;
```

This is how "at most one foreground desktop-automation task at a time" is enforced — as a database
constraint, not as an application check that a second worker can race past.

---

## 5. Identity: first-pairing binding

The message ingress originally executed anything that arrived in the session. Anyone able to post
into that conversation could drive the machine.

The fix is deliberately the simplest thing that works for a single-owner deployment:
**the first sender to arrive becomes the owner**, persisted in `tasks.owner_open_id`; every later
sender is rejected. There is no account registry, no OAuth flow, no shared secret to store —
and therefore nothing new to leak. Re-pairing requires local access
(`runtime owner reset`), which is exactly the intended authority boundary.

---

## 6. Resource policy: fail closed, and why that forced a second component

The policy function maps telemetry to `{ slotLimit, acceptsNewActions }`. The original
implementation returned `acceptsNewActions: true` when given an empty object — it treated
"I know nothing about this machine" as "go ahead at full capacity".

It now **fails closed**: any missing or non-finite reading yields `slotLimit: 0` and an explicit
`missing: [...]` list. A subtlety worth noting, because it is the kind of bug that hides for
months: `Number(null) === 0`, so a naive numeric coercion turns *absent CPU data* into
*0% CPU load* — the most permissive possible value. Hence `toFiniteNumber()`, which rejects
`null`, `undefined`, `NaN`, and infinities rather than coercing them.

Failing closed created a new problem. `os.cpus()` returns all-zero time slices in some
environments (containers, and some virtualised Windows configurations), so CPU load could not be
sampled at all — which, under a fail-closed policy, means the agent would *never run*. This is
why `telemetry.mjs` and `platform/windows/Write-DailyTwinTelemetry.ps1` exist: a
PowerShell sampler writes a timestamped JSON snapshot, and the Node side accepts it only if it is
under 300 seconds old. Environment variables provide a third, debugging-only path.

Every reading reports **where it came from** (`local_sample` / `env` / `file` / `unavailable`)
and, when unavailable, a machine-readable reason code. An earlier version reported
`source: 'file'` even when no value had been obtained, producing the self-contradictory
diagnostic pair `source=file` alongside `reason=file_missing`. A provenance field that can lie
is worse than no provenance field.

---

## 7. Execution verification: the core lesson

The single most instructive failure in this project's history: the agent reported that VS Code
had been launched and that its process was "confirmed running". An independent cross-check found
that VS Code **was not installed on the machine at all** — absent from the registry, `PATH`,
Start Menu, the target drive, and the process list.

The agent had not lied about the outcome of a check. It had never performed one.

The architectural response is that success is no longer something a component may assert.
`execution-verifier.mjs` recognises exactly four kinds of evidence — `process`, `window`, `page`,
`file` — each with structural requirements (a `process` claim needs a positive integer PID and a
process name; `window`, `page`, and `file` need a target). `finalizeTask()` downgrades any task
without valid evidence to **`partial`**, never `completed`, with an explicit reason.

The built-in executor is a placeholder that always returns `partial` with the message
"no executor configured — this run does not falsely claim success". Reporting honest failure is
the correct default behaviour for an unconfigured system; reporting success is not.

The general principle, and the one worth carrying to other work: **an agent's self-report is
evidence about the agent, not about the world.** Any claim that something happened outside the
process must be backed by an observation of the world.

---

## 8. Scheduler: dormant by default

`scheduler.enabled` defaults to `false`. `start()` returns
`{ started: false, reason: 'scheduler_disabled' }` and the operator must opt in explicitly.

For software that can open a browser holding live logins and launch executables on a machine
someone else is using, the safe default is not "on". A capability that activates on installation
gives the operator no window in which to verify configuration.

The executor contract is intentionally narrow —
`{ task, store, config }` → `{ outcome, summary?, reason?, evidence?[] }` — so that the real
executor can be supplied from the private directory and the public repository never needs to
contain machine-specific automation.

---

## 9. Browser routing

Web work needs a signed-in browser session while nobody is at the computer. Those two
requirements together eliminate most options, and the elimination was not obvious from the
tool names.

The finding that resolved weeks of confusion: **the built-in profile named `chrome` is Chrome by
definition** — it denotes a Chrome *extension* driver, not "a browser". Passing
`--browser-profile chrome` will never open Edge, and the local auto-detection order
(Chrome → Brave → Edge → Chromium → Chrome Canary) means Edge is never selected on a machine
that has Chrome installed.

`browser-router.mjs` encodes five profiles with explicit `driver`, `browser`, `unattended`, and
`documented` flags, and returns refusals with reason codes
(`requires_human_at_computer`, `unknown_profile`) plus non-blocking warnings for every known
risk — including "this profile drives a different browser than you asked for" and
"this route is not covered by upstream documentation and has not been verified here".

Making the uncertainty a first-class field, rather than a comment, is the point. The full
analysis, including the two additional causes (tool-profile filtering and plugin gating), is in
`docs/BROWSER-PROFILES.md`.

---

## 10. Cross-language boundary

Node handles state, policy, and orchestration. PowerShell handles everything that requires
Windows APIs: scheduled tasks, CIM/WMI queries, process and window inspection, drive geometry.

The boundary is **JSON over stdout**, with three rules learned the hard way:

- **No BOM on written files.** A UTF-8 BOM makes `JSON.parse` throw on the first character.
  The Node reader is nevertheless BOM-tolerant on input, because tolerant readers and strict
  writers is the combination that survives contact with mixed toolchains.
- **Atomic writes.** Write to `.tmp`, then `Move-Item` over the target, so a reader never
  observes a half-written file.
- **No `Get-Counter`.** Performance-counter path names are localised; on a Chinese-language
  Windows install, `\Processor(_Total)\% Processor Time` does not resolve. CIM class *property*
  names are not localised, so `Win32_PerfFormattedData_PerfOS_Processor` is used instead.
  This class of bug is invisible on an English-locale development machine.

Script files themselves are UTF-8 **with** BOM and CRLF line endings — that is what Windows
PowerShell 5.1 requires to read non-ASCII source correctly. `.gitattributes` pins the line
endings so a checkout on another platform cannot silently break them, and CI re-verifies both
properties after checkout.

---

## 11. Verification strategy

Four independent layers, because each catches a class the others cannot:

| Layer | Command | What only this layer catches |
|---|---|---|
| Unit tests (132) | `npm test` | Logic invariants, migration correctness, redaction |
| Privacy audit | `npm run audit:privacy` | Secrets or personal paths about to be committed |
| CLI smoke test | `npm run smoke` | End-to-end behaviour, including *absence* of side effects |
| PowerShell lint + self-test | `npm run lint:ps`, `npm run selftest:ps` | 5.1 syntax, encoding, runtime behaviour of scripts |

Two properties of this suite are worth calling out, because they are what makes it trustworthy
rather than merely green:

**Negative controls.** Every forbidden-pattern rule carries a `bait` string, and two tests assert
that (a) each rule fires on its own bait, and (b) no rule fires when the bait appears inside a
comment or string literal. A detector that has never been observed to fire is not known to work.

**Guards against false green.** The privacy audit fails if it scanned fewer than 20 files —
otherwise a broken directory walk would report "pass" while scanning nothing. The PowerShell
linter fails, rather than skipping, when PSScriptAnalyzer is unavailable — a check that silently
disappears is worse than no check, because it still reports success.

The lexical scanner (`scripts/lib/powershell-source.mjs`) exists for a related reason: these
scripts deliberately document bad examples in comments and strings, so pattern rules run against
a version of the source in which comments and string literals — including here-strings — have
been replaced by equal-length whitespace, preserving both line numbers and total length.

CI runs the Node suite on `ubuntu-latest` and the PowerShell suite on `windows-latest`, the latter
under both `shell: powershell` (Windows PowerShell 5.1, the authoritative 5.1 syntax check) and
`pwsh` (7.x). A final integration step writes a telemetry file from PowerShell and asserts that
the Node `doctor` command reads it back with the expected provenance — the cross-language contract
tested as a contract, not as two independent unit suites.

---

## 12. What is not verified here

Stated explicitly, because an architecture document that omits its own limits is marketing:

- The PowerShell scripts' **runtime** behaviour on real Windows: scheduled-task registration,
  CIM queries, window inspection. Development happened in a Linux container; only syntax,
  encoding, static analysis, and the platform-independent subset of the self-test run there.
- The **Windows PowerShell 5.1 syntax boundary**. The development environment has only
  PowerShell 7.6.4, where several 7-only constructs parse without complaint. That judgement is
  delegated to the `windows-latest` CI job.
- Whether **Edge** can load the same unpacked extension as Chrome. Marked
  `documented: false` in code, warned on at every routing decision, and listed as the one
  genuinely open question in `docs/BROWSER-PROFILES.md`.

---

## 13. Deferred work

The full token and context plane — a context compiler, prompt-cache classes with explicit
stability tiers, and per-worker context namespaces for isolation — is **deferred to a following
round**. This round establishes only the ledger (`token_ledger`, including a `cached_tokens`
column) so that cost and cache-hit data start accumulating before the optimisation work begins.

Optimising context assembly without a baseline measurement would be guesswork; the ledger is
the measurement.
