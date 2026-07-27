# Browser Routing Design

## Context

Daily Digital Twin must reuse the user's normal Edge session for authenticated work without silently launching a separate managed browser. Chrome remains available only when the user explicitly requests it or when Edge cannot complete a public, read-only task.

The current failure mode is caused by treating browser automation as arbitrary shell execution. That selects the managed OpenClaw browser profile, triggers repeated command approvals, exposes oversized accessibility snapshots, and loses the user's Edge login state.

## Goals

- Use the user's existing Edge session by default.
- Keep Chrome as an explicit or public read-only fallback.
- Prevent browser choice from changing account identity or task semantics.
- Avoid per-click shell approvals by using a structured browser bridge.
- Minimize token usage and never expose raw page snapshots in chat.
- Keep browser state, screenshots, cookies, and task evidence private.

## Non-Goals

- Reading browser password stores or exporting cookies.
- Keeping Edge and Chrome running solely for the agent.
- Automatically moving authenticated or mutating work between browsers.
- Giving the model unrestricted CDP, PowerShell, or shell access.

## Considered Approaches

### Native Edge Only

Use the OpenClaw Edge extension and its structured browser tool for every task. This has the smallest approval surface, but it does not reuse the existing `web-access` history lookup and targeted DOM helpers.

### Web-Access Only

Expose the existing `web-access` skill through a directory junction. A junction makes the skill discoverable but does not make its Node and HTTP commands trusted tools, so shell approvals would remain.

### Native Edge With Web-Access Support

Use the OpenClaw Edge extension as the primary control path and expose `web-access` through a narrow local adapter for history lookup and complex DOM operations. This is the selected approach because it preserves existing login state while keeping browser actions structured and auditable.

## Routing Policy

The router receives four inputs: requested browser, whether private login state is required, whether the task can change remote state, and current browser availability.

1. Edge is the default for every browser task.
2. An explicit user request for Chrome selects Chrome.
3. Google or another search engine does not imply Chrome; search may run in Edge.
4. If Edge fails, a public and read-only task may retry once in Chrome.
5. If Edge fails during an authenticated or mutating task, the task enters `waiting_for_user` and does not switch browsers.
6. Chrome fallback must be recorded in the final receipt with the Edge failure reason.
7. The managed OpenClaw browser profile is never an implicit fallback.

Browser failure means the selected browser is unavailable, its controlled task tab cannot be created, or a verified compatibility error prevents progress. A missing page result or model uncertainty is not sufficient reason to switch browsers.

## Components

### Browser Router

A pure policy module returns `edge`, `chrome`, or `waiting_for_user` plus a machine-readable reason. It has no browser or process access and can be unit tested independently.

### Edge Bridge

The primary bridge uses the paired OpenClaw extension in Edge. It creates task-owned background tabs, returns stable tab identifiers, supports targeted reads and actions, and verifies resulting page state.

### Web-Access Adapter

The private runtime may link the installed `web-access` skill into OpenClaw's skill directory. A local adapter resolves the skill path and exposes a constrained set of operations such as URL history lookup, target creation, targeted DOM evaluation, screenshots, and task-tab closure.

The model must not invoke `node`, `curl`, or `openclaw browser` through general `exec`. The adapter validates operation names, target ownership, payload size, and allowed local endpoints before forwarding a request.

### Chrome Fallback

Chrome starts only for an explicit request or an eligible read-only fallback. It uses a task-owned tab and closes that tab on completion. The runtime must not keep Chrome open after the last Chrome task unless it was already running for the user.

## Tab Ownership

- Each task receives its own browser target identifier and browser lock.
- The agent may only read or mutate targets owned by that task.
- Existing user tabs are not modified unless the user identifies a specific tab as task input.
- Moving a task tab out of the controlled group revokes control immediately.
- Task-created tabs close after completion, failure, or cancellation unless retained as evidence by explicit user request.

## Approvals

Navigation, targeted page reads, ordinary clicks, and text entry inside a task-owned tab do not use shell approval.

Login, captcha, two-factor authentication, file upload, message sending, form submission with external effects, publishing, purchasing, account changes, and destructive actions enter `waiting_for_user`. Approval applies to the described action, not to unrestricted future browser control.

## Token And Privacy Controls

- Prefer selectors and bounded DOM extraction over full accessibility snapshots.
- Enforce configurable character and node limits on browser observations.
- Do not send raw tool output, DOM trees, cookies, passwords, tokens, or hidden form values to Feishu.
- Store screenshots and detailed evidence only in the private runtime.
- Send one concise final receipt containing outcome, browser used, evidence reference, completed parts, and failure reason.
- Keep task, worker, and browser observations isolated between sessions.

## Resource Policy

- Do not launch Chrome while Edge can complete the task.
- Do not keep a browser alive solely for an idle agent.
- Browser tabs may run concurrently, but foreground keyboard and pointer actions remain single-threaded.
- Existing CPU, memory, disk, battery, and four-slot limits continue to gate new browser actions.

## Failure Handling

- Retry a transient bridge or page-load error once in the same Edge task tab.
- Public read-only work may retry once in Chrome after a verified Edge failure.
- Authenticated or mutating work never retries in another browser.
- Stale references trigger one bounded re-read of the same task tab.
- Repeated failure produces a final receipt instead of an unbounded tool loop.

## Acceptance Tests

1. A normal public search opens in Edge and never launches Chrome.
2. Google Search in Edge is treated as Edge work, not as a Chrome request.
3. An authenticated Biomni task reuses the existing Edge login state.
4. An explicit "use Chrome" request creates a Chrome task tab.
5. A verified Edge failure during public read-only work falls back once to Chrome and records the reason.
6. A verified Edge failure during authenticated or mutating work pauses without opening Chrome.
7. Browser actions do not invoke general `exec` and do not request approval per click.
8. Raw DOM and accessibility snapshots never appear in Feishu replies.
9. A task cannot read or act on another task's tab.
10. Task-created tabs close at terminal task states and no unnecessary browser process remains.

## Rollback

Disable the private web-access adapter and restore the previous browser policy. The change does not delete browser profiles, cookies, task data, or Edge extension state.
