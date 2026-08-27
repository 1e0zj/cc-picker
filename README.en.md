# cc-picker

[![npm](https://img.shields.io/npm/v/cc-picker.svg)](https://www.npmjs.com/package/cc-picker)

**English** | [中文](README.md)

A multi-provider launcher for Claude Code — run several terminals, each on its own model; see at a glance from the status line which account is active and how much quota is left.

## What problem does it solve

If you use Claude Code daily, you've probably hit these two pain points:

- **Multiple terminals open at once, each supposed to use a different model.** cc-switch can't do this — it switches the global config, so every terminal changes together.
- **More and more provider subscriptions, and switching is tedious and error-prone.** Every time you have to switch in cc-switch, then run `/model` to confirm which provider the current terminal is actually using.

cc-picker's approach is simple: it uses the [`--settings`](#how-it-works) launch flag to give each process its own provider config file — **which provider each Claude Code process uses is decided the moment it starts, with no cross-talk**. Combined with a custom status line showing `[account] model · directory · context% · quota`, you never have to guess who you're talking to or how much is left.

A typical day then looks like: one terminal on the official API, one on a personal GLM account, one on a company GLM account, one on DeepSeek, all running at the same time. Once you're used to it, `ccp glm` gets you there in two words — or right-click any directory → "Claude Code (pick model)".

> **Cross-platform**: Windows / macOS / Linux all run the same Node implementation — the `ccp` launcher, the status line, and the `ccm` web manager; provider configs work everywhere. The right-click menu exists on Windows and macOS; Linux is skipped because every file manager handles context menus differently.

## Screenshots

| `ccm` manager | Add provider |
|:---:|:---:|
| ![ccm manager: card-based provider list with edit / test / delete](docs/manager.png) | ![Add provider: one-click presets for official / GLM / DeepSeek](docs/provider-edit.png) |

The status line always shows `[account] model · directory · context% · quota`:

![Status line: [glm] glm-5.3[1m] · cc-picker · ctx 0%](docs/statusline.png)

## Features

| Capability | Details |
|---|---|
| `ccp` command | Pick a provider from a terminal menu to launch; `ccp glm`, `ccp deepseek-work` go straight to one once you know the names; all other arguments pass through to claude — `ccp glm --continue`, `ccp --resume` |
| `ccm` manager | GUI to add / edit / delete provider configs (cc-switch-style raw JSON editing); cards show Claude official/GLM 5-hour and 7-day quotas and DeepSeek CNY balance, with a 5-minute cache and per-card refresh; one-click presets for GLM / DeepSeek / official; connectivity test; a "default" button to switch the provider used by bare `claude`, and a "common config" editor for the global settings.json — can fully replace cc-switch. Browser page; the local server listens on 127.0.0.1 only |
| Status line | Always-on `[account] model · directory · context% · 5h% · weekly%`, identifying the account by matching the token back to config files — even a bare `claude` is identified |
| Right-click menu | In Windows Explorer or macOS Finder, right-click a folder → "Claude Code (pick model)" → a new terminal opens in that directory with the picker menu; the picker is just `ccp`'s terminal menu. Installed together with the rest |
| Quota display | Official-subscription numbers in the status line come from Claude Code's built-in rate_limits; the manager reuses the local Claude Code OAuth login for official-subscription queries. GLM (5h/weekly) and DeepSeek (balance) are queried in the background and cached (`cc-usage`); on failure the last successful value is kept. In a terminal, `ccu` shows usage and reset countdowns for all providers at a glance |

## Quick start

Prerequisites: Claude Code installed; Node 18+ (usually already there if Claude Code is). Same three steps on all platforms:

```bash
# 1. Install — globally via npm (recommended)
npm install -g cc-picker
cc-picker install
#    or run once without installing: npx cc-picker install
#    or clone this repo and run: bash install.sh

# 2. Open the manager (local web page, browser opens automatically), paste in tokens
ccm

# 3. Open a new terminal
ccp           # pick from a menu
ccp glm       # go straight to one config
ccu           # quota/balance overview (ccu glm for a single provider)
```

Installation deploys to `~/.claude`: `ccp.js` (launcher), `ccm.js` + `ccm-page.html` (web manager), `cc-statusline.js` (status line), `cc-usage.js` (quota/balance queries), `ccu.js` (CLI quota overview), `cc-menu.js` (right-click menu install/uninstall), `providers/*.json` (config templates), plus `ccp` / `ccm` / `ccu` shell functions for bash / zsh (Git Bash on Windows) and the `statusLine` key in settings.json.

The right-click menu is part of this — on Windows it writes an HKCU registry key (no admin needed), on macOS it drops a Quick Action into `~/Library/Services`. Don't want it? `cc-picker install --no-menu`, or later `cc-picker menu uninstall`; to add it back separately, `cc-picker menu install`.

Everything runs from the stable `~/.claude` path — switching node versions or uninstalling the npm package doesn't affect what's already deployed. Users who installed globally via npm also get the four commands `ccp` / `ccm` / `ccu` / `cc-picker`; maintain with `cc-picker install | uninstall | status`.

## Updating

```bash
cc-picker update
```

This pulls the latest npm package, refreshes the scripts in `~/.claude`, rewrites the shell function block (this is how new commands like `ccu` reach your shell), and performs migrations from older versions: rewrites an installed right-click menu, replaces a statusLine still pointing at `cc-statusline.ps1` with the Node version, and deletes `cc-*.ps1` leftovers from the PowerShell era (`providers/*.json` and your own settings.json are untouched). The equivalent is simply `npm install -g cc-picker@latest` — the package's postinstall does the same script refresh; the function block and migrations are completed on the next `cc-picker update`.

Why the refresh step exists: what runs under `~/.claude` is a copy made at install time (statusLine, shell functions, and the right-click menu all hardcode that stable path, so node upgrades or npm uninstalls don't break them), while swapping the npm package only replaces the sources in `node_modules`.

`cc-picker status` diffs every script in `~/.claude` against the current package and names any that differ. For repo clones: `git pull && bash install.sh`.

## How it works

It all comes down to one command:

```
claude --settings ~/.claude/providers/glm.json
```

- `--settings` lives in the command-line layer; it takes priority over the user-level `~/.claude/settings.json` and **merges layer by layer** — keys written in the provider file override the global ones, keys it doesn't mention are inherited (global behavior switches are unaffected).
- **Why not shell environment variables** (`ANTHROPIC_BASE_URL=xxx claude`)? Because the `env` block of a settings file writes same-named variables back into the process environment at startup, overriding what the shell passed in — as long as the global config contains `ANTHROPIC_BASE_URL`, the env-var approach breaks. `--settings` is the only reliable per-process override.
- Each process reads its own arguments at startup, so multiple terminals don't interfere — that's exactly how "one window on official, one on GLM" works.

All `ccp` does is pick a provider file and fill in the path; all the right-click menu does is `cd` into the directory you clicked and bring up `ccp`.

## Relationship to cc-switch

ccm has its own "default" button and "common config" editor and **can fully replace cc-switch**: clicking "default" on a card **merges** that provider's env into the global settings.json — non-empty keys override, empty-valued keys clear, unmentioned keys are kept (hand-written common config in settings.json is not lost), other top-level keys like `statusLine` are preserved, and bare `claude` picks it up immediately. The official provider (an all-empty template) means "clear all provider keys, back to official".

If both coexist: they both rewrite settings.json and clobber each other — pick one and stick with it. cc-switch **rewrites settings.json wholesale** on every switch, keeping only the top-level keys registered in its "common config" — so this project's `statusLine` must be added to cc-switch's Claude common config, or the status line disappears after a switch (the installer warns when it detects cc-switch).

## Migrating across machines

1. Install once on the new machine: `npm install -g cc-picker && cc-picker install` (or clone this repo and run `bash install.sh`);
2. Copy `~/.claude/providers/*.json` (they contain plaintext tokens — mind the channel), or reconfigure via `ccm` on the new machine. The providers format works on all platforms.

Tokens never go into the package; templates only contain placeholders.

## Uninstall

```bash
cc-picker uninstall   # installed globally via npm
bash uninstall.sh     # installed from a repo clone
# both clean up scripts, caches, shell functions, statusLine, and the right-click menu;
# providers (with tokens) are kept by default

cc-picker menu uninstall   # only remove the right-click menu, keep everything else
```

### Migrating from the old PowerShell version

Since v0.1.2 Windows uses the Node version too; `cc-setup.ps1` is no longer maintained. The right-click menu has been redone in Node and installs with `cc-picker install` (the picker went from a WinForms popup to `ccp`'s terminal menu); the only feature not carried over is coloring terminal tabs per provider.

Running `cc-picker update` once on an old machine migrates automatically: it rewrites the registry right-click menu, swaps a statusLine pointing at `cc-statusline.ps1` for the Node version, and deletes the `cc-*.ps1` scripts the old version deployed (providers and caches are untouched; the Node version keeps using them).

The only manual step is the `>>> cc 多供应商启动器 >>>` marker block in your pwsh profile — delete it so `ccp` / `ccm` in pwsh resolve to the Node commands from the global npm install.

## FAQ

- **Status line disappeared?** If cc-switch is installed, see the section above — add the `statusLine` block to its common config.
- **Where does the account name in the status line come from?** At startup, `ANTHROPIC_AUTH_TOKEN` from the process environment is matched against `providers/*.json`; a match displays the file name. No match falls back to the hostname of `ANTHROPIC_BASE_URL`; if both are empty, it shows `official`.
- **Where do the quotas (5h/7-day) come from?** Official-subscription data in the status line is provided directly by Claude Code via `rate_limits`; the CCM page reads the OAuth login from the local `~/.claude/.credentials.json` (on macOS, compatible with Claude Code Keychain) and queries Anthropic's usage endpoint. GLM calls Zhipu's quota API, DeepSeek calls the balance API; results are cached in `~/.claude/cc-usage-cache.json`. CCM refreshes every 5 minutes or on card click; the status line refreshes asynchronously only after 10 minutes. Tokens are only sent to their respective official endpoints. Zhipu's TIME_LIMIT is a monthly allowance for add-on products like search/web reading and is not shown.
- **Right-click menu not showing?** Run `cc-picker menu status` first to see how it was installed. On Windows the menu entry lives at `HKCU\Software\Classes\Directory\shell\ClaudePicker`; if Windows Terminal wasn't installed at setup time, the command falls back to a cmd window — after installing wt, rerun `cc-picker menu install` to switch over. On macOS, enable "Claude Code (pick model)" under System Settings → Keyboard → Keyboard Shortcuts → Services for it to appear in Finder's Quick Actions.
- **The window opened by the right-click menu doesn't close after claude exits?** Intentional — the command uses `cmd /k` so the window stays open and you can read `ccp`'s errors.

## Development & release

Releases go through GitHub Actions: push a `v*` tag and [release.yml](.github/workflows/release.yml) runs version check → sandbox verification → npm publish.

```bash
npm version patch        # bumps package.json + tags + commits (minor/major likewise)
git push --follow-tags
```

Publishing uses npm **trusted publishing** (OIDC): no npm token is stored in the repo; GitHub issues a short-lived identity token for the publish, and provenance is generated automatically. The initial 0.1.0 was published manually with Trusted Publishers registered on npm; everything since is tag-triggered.

## License

[MIT](LICENSE)
