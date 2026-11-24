# HomuCode

HomuCode is a fork of [T3 Code](https://github.com/pingdotgg/t3code), changed for running many coding agents at once. Linux x86_64 AppImages are available from [HomuCode releases](https://github.com/homura-ai/homucode/releases/latest). For other platforms, build it from source. The app displays the name HomuCode. The command is still `t3`.

## Changes compared to T3 Code

The full list, with details, is in [CHANGES.md](./CHANGES.md). In short:

- **Server speed.** Faster CLI calls and activity reads, cached Git config reads, Linux memory caps that queue agent starts until there is room, opt-in 30-day T3 Connect passes that avoid a cloud round trip on most launches, and a setting to switch off background Git work (`T3CODE_BACKGROUND_GIT=0`).
- **Status line.** Context and quota dials, quota forecasts, burn-rate countdowns, per-thread weekly quota estimates, and custom commands on desktop, web, and mobile.
- **Threads and subagents.** Move threads under other threads, move or copy threads to projects on other devices, pinned subagents with opt-in pin inheritance, sidebar folders that sync to mobile, sidebar search filters and sorting, Stop that stops only the current thread, opt-in bare "stop" or "wait" messages that halt the running turn, settling a working thread files it when its turn ends, every message marked as from a human (with device) or automatic (with its sender), `/q` for a quick question on a cheaper model, `/cd` to move a thread to another folder, a snooze menu with Custom… first and configurable presets with fractional durations that can wake days ahead, approval prompts instead of refusals for project and environment changes below Full access, agent tools and `t3 thread organize` for the thread menu's remaining safe actions and Settings, and opt-in autoreviewers.
- **MadoHomu.** An opt-in view for one project, with its threads in sections you arrange, its own desktop app and Android launcher, and an optional morning brief.
- **Feature offers.** Setup offers the opt-in features on two pages, with HomuTheme preselected on first install, and users are shown a selection page with new features after an update. You can revisit each choice in Settings.
- **Queue and steering.** Auto and steer delivery that steers as soon as the turn can take it, Ctrl+Enter to steer every queued message, resending of Claude steers that Stop left unread, idle model picks that apply to incoming messages, opt-in model and effort changes that restart a running turn on the new setting, and messages sent while the previous one is still sending that wait and send themselves.
- **Desktop, CLI and mobile.** Presses and keys dropped when they land just as the UI changed under them, opt-in settings sync across web, desktop and phone, opt-in TypeScript app scripts run from a keybinding or `t3 app run`, faster CLI launches, an opt-in phone launch that connects without waiting for sign-in, over-the-air Android updates, Linux desktop link fixes, undo for a staged build, app and provider updates once agents are idle, and smaller fixes.
- **HomuCode settings.** Find the fork’s options in the HomuCode group of Settings on web and desktop, and under Settings → HomuCode on mobile.
- **Add-ons.** Optional build tools in [`addons/`](./addons/README.md), all off by default. Building Homu under Settings → HomuCode runs cloud builds and staged-build loading with rollback, builds Android APKs and serves them on the LAN.

Only builds from this repository have these changes; upstream's published apps don't. See [Known limits](./CHANGES.md#known-limits).

## What T3 Code is

T3 Code is an "agent harness control surface": one place to control the coding agents on your machine, from a desktop app, a web app or a phone. It works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity and fx. Install and sign in to at least one provider before use:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
- fx: install [fx](https://fx.sh) and run `fx login` on the machine running the server ([setup guide](./docs/user/providers-fx.md))

For upstream's releases, apps, issues and community, see [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## Building from source

T3 Code uses Vite+, so you need the global `vp` command-line tool:

```bash
curl -fsSL https://vite.plus | bash
```

On Windows, in PowerShell:

```powershell
irm https://vite.plus/ps1 | iex
```

Then install the dependencies:

```bash
vp i
```

Start at [docs/internals/overview.md](./docs/internals/overview.md) for how the pieces fit together and how to run and build them.

## Documentation

The docs live in [docs/](./docs):

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)
