# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, the update button at the bottom
of the sidebar and **Settings → Environments** offer to update it.

## HomuCode builds

Linux AppImages from [HomuCode releases](https://github.com/homura-ai/homucode/releases/latest)
use the fork's update feed. Download the latest AppImage there if updating in the app fails.
Builds you package yourself need a rebuild unless you configured an update feed.
The upstream release channels, standalone CLI releases, and app-store updates described below
do not supply HomuCode's fork features.

For an AppImage staged to load on the next start, **Settings → HomuCode → Building Homu** shows the staged
build. When the **Building Homu** page is enabled, look there.
**Undo** disables that AppImage so the preceding staged build loads instead; the notice offers **Redo**.

## Update everything at once

The update button at the bottom of the sidebar updates every connected machine
in one step. It updates outdated providers, then servers that are behind, then
the desktop app you are using. Servers move to the
version your desktop app is installing, or to your web app's version. A
background service stays on its current release channel. A remote desktop app
installs the latest release from its own channel. Hover the button to see what
it will update.

While it runs, the button widens to show progress. It names a machine that is
taking longer than usual, and offers **Retry** for a server that failed. Click
it to see every machine. The desktop app restarts once each server has started
its own restart, after a short countdown. Choose **Later** to keep working and
restart from the update button when you are ready. A server still restarting
finishes on its own, and the button keeps showing it after the desktop app
restarts.

Each server checks that it can install the release before it restarts. If the
release is not available to a server yet, its update fails, the server keeps
running, and you can retry. The confirmation lists each machine it skips and
why, such as a machine that is offline or needs a manual update. Use
**Settings → Environments** for those.

If a desktop app restarts on its old version, T3 Code tells you the update did
not apply. It does not install that version again on its own, even when another
device asks. Use the update button on that machine to retry.

The confirmation counts the running threads that the restarts will interrupt,
and how many can resume afterwards. See **Continue threads after restarts**
below.

## Update automatically when agents are idle

Each machine installs updates on its own once its agents have stopped working
for five minutes. The desktop app installs a new version, downloading it first
if needed, once no thread on that machine has run for five minutes and nobody
has used the keyboard or mouse on that machine for five minutes. Each
provider updates once none of that provider's threads on that machine have run
for five minutes, so a busy Codex thread does not hold back a Claude update.
Each version is tried once per start, so a failed update waits for you.

It is on by default. Turn it off for a machine under **Settings → HomuCode → Misc.+Agent behavior →
Extra features → Update when agents are idle**.

## Switch between Stable and Nightly

In the desktop app, change **Settings → About → Update track**. T3 Code shows each
connected machine it will move and each one it skips, then moves them in one
step. Remote servers install the latest release on the new track. Remote desktop
apps reinstall on the new track. This app reinstalls last.

A background service cannot move to an older release remotely. When Stable is
older than its Nightly, run `t3 update --channel stable --allow-downgrade` on
that machine.

A switch is blocked for a machine whose database already has changes the
target release does not support, or when T3 Code cannot confirm that it does.
The dialog says why: update a machine on its current track first when its
release is too old to check, or wait until the target track includes the
changes. A Mac running the desktop app must switch on that Mac.

Each machine keeps the new track even if its switch did not finish, but it
moves to that track only through a switch. **Update track** shows how many
machines still run the other track. **Review** opens the same dialog with fresh
checks.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting.
If a supported environment was offline or has a different value, use **Apply
to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, a Claude
monitor, or a command or other monitor the agent said it was waiting on is woken and told that
this work stopped. Claude commands also count when **Settings → Threads → Keep Claude threads
working while background commands run** is on. That setting is off by default and applies to
new background tasks without restarting. Other background shells and monitors, such as a dev
server and its watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three consecutive crash recoveries
of an unfinished turn, the thread waits for your next message, even when crashes
are more than five minutes apart. A completed turn or a planned shutdown resets
that limit.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Run the command on the named host to update the detected global npm install or installed `t3` command, then restart the server with your usual options.                                         |
| **Copy relaunch command**  | Stop the command-line server on its host and relaunch with the copied command, keeping your usual subcommand and options. This does not update an installed `t3` command.                       |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

Only one server can use a T3 home directory at a time. If startup reports that
another server owns it, stop that server before retrying, or use a separate home
directory and pair with the running server.

## If the desktop app does not start

If the desktop app's server keeps failing at startup, T3 Code shows a "T3 Code
could not start" window instead of the app. If a newer version is available,
choose **Update** to install it. If not, the window links to the last version
that started on your computer. Download and install it to go back. Use **Copy
details** to include the error in a bug report.

## Registries and proxies

Each server checks T3 Code releases, and providers installed with npm, through
its own npm, so the checks use npm's configured registry, authentication, and
proxy settings. Providers installed with Homebrew or pnpm check through those
tools.
Configure npm on the server's machine. If that registry cannot be reached, the
release shows as unavailable; T3 Code does not try the public registry instead.
Machines without npm check the public npm registry directly.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. A provider is left out
when any of its enabled, outdated instances offers only a manual update command,
or when its instances use different update commands, such as two instances that
run different CLI installs. Update those by hand, or point every instance of the
provider at the same CLI.

After a successful provider CLI update, T3 Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest T3 Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions. The same setting controls whether
T3 Code downloads model catalog updates, so with it off new models may not appear
until you enable it and refresh provider status.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

## Build a development version

Enable **Show Building Homu settings** in **Settings → HomuCode → Building Homu**. On mobile, open **Building Homu** there.
Choose the server's T3 Code checkout, boat CLI, machine type and output folder. Enable cloud
builds or Android APK builds, choose a committed ref (default `origin/main`), and confirm the
build. The boat CLI must be installed and signed in on that server. Status reports the result
and artifact path. Uncommitted edits are excluded.

Android builds return a signed development APK under `~/app/mobile`. **Serve APKs on LAN**
provides a phone download URL on port 8767. Turn it off when finished; serving also stops when
the server exits. The server needs its Android signing key configured before building.

On AppImage installs, enable loading builds, choose a staged AppImage and its SHA-256 checksum,
and confirm loading. T3 restarts and automatically rolls back if it fails to return. Set the
AppImage folder to control which folder the loader launches from. The running and next builds
are shown there; Undo excludes the newest build from the next launch, and Redo restores it.
On desktop, Undo is available in **Settings → HomuCode → Building Homu** while Building Homu is hidden.
