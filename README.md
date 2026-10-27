# cc-crew

Independent reviews for Claude Code, from Codex, Antigravity and Claude. Each gets a separate conversation,
a self-contained brief and a set of paths it may read. Reports go into the project, and background results come back
into the session through cc-conversation.

Provided as is.

## Requirements

- Claude Code 2.1.296 or later. The sidebar needs fullscreen rendering; outside fullscreen nothing is drawn.
- [cc-sidebar](https://github.com/wfthkttn/cc-sidebar) and
  [cc-conversation](https://github.com/wfthkttn/cc-conversation).
- The Codex CLI for Codex reviewers, signed in once with `codex login --device-auth`.
- Claude Code itself on the PATH (or named by `claude_bin`), signed in to Claude, for the Claude reviewer.
- The Antigravity CLI, `agy`, for Antigravity reviewers, signed in once by running `agy` in a terminal.
- Bash for reading Codex's model catalog; on Windows, Git Bash.

## Install

From the marketplace `wfthkttn` ([cc-mods](https://github.com/wfthkttn/cc-mods)), at a Claude Code prompt:

```
/plugin install cc-crew --marketplace wfthkttn/cc-mods
```

Answer `y` to add the marketplace, then pick a scope. cc-sidebar and cc-conversation install with it.

Or load it from a directory: the plugin is this repository's root. Clone it and list the clone in
`~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-crew" }
```

Load cc-sidebar and cc-conversation too, from the marketplace or their own directories.

## What it does

The tool `mcp__cc-crew__review` takes a short `description` and a `prompt` containing the brief. Reviewers do not get
this session's conversation. A call can choose its providers, models and reasoning effort; otherwise the plugin's
configured defaults apply. The default providers are Codex, Antigravity and Claude.

Reviews run in parallel and in the background by default. The tool returns a run id; once every reviewer finishes,
the session receives their statuses and report paths. `background: false` waits for the results instead. One
reviewer's failure leaves the others running.

Reports go under `<project>/.claude/work/reviews`, in a folder for the run, with its brief and a Markdown report for
each reviewer. A custom `report_dir` must remain under `<project>/.claude/work/`. Reports include the summary,
findings, what was checked and what was not read when the reviewer returns the requested structure.

`mcp__cc-crew__review_continue` sends a follow-up to one finished reviewer in its own conversation.
`mcp__cc-crew__review_status` reports runs and, when no run is specified, attempts an Antigravity quota read.

### Read limits

`read` is `"project"` by default, `"none"` for no files, or a list of files and directories. Relative paths are
relative to the project. Secret filenames such as `.env`, private-key files and credential files are excluded by
name; this does not find secrets stored under other names.

Codex runs with a read-only filesystem profile. Antigravity gets a restricted tool list and path deny rules.
The Claude reviewer, like a reviewer from `reviewers.json`, runs Claude Code headless (`-p --restricted --safe-mode`)
with Read, Grep and Glob only, in a working folder of its own, the read paths added beside it, and deny rules for
secret files and for Claude's own session records and credentials; none of your CLAUDE.md, settings files, plugins,
hooks or MCP servers load into it. Its child runs on Claude whichever backend the session itself uses: the variables a
wrapper such as `zai` sets to point Claude Code at another endpoint (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `API_TIMEOUT_MS`) are emptied for it. A reviewer
from `reviewers.json` keeps the environment its own command sets.

### More reviewers

`~/.config/crew/reviewers.json` adds reviewers that run Claude Code headless through a command of your choosing, for
example a wrapper that points it at another endpoint or account. Each is called by its name like a built-in, gets a
switch under Limits, and counts in a group of `models.json` whose `provider` is that name:

```json
{ "glm": { "kind": "claude-p", "command": ["claude-glm"], "model": "opus" } }
```

- `command`: the program and its first arguments; crew appends `-p` and the rest. On Windows, a script needs its
  interpreter first, e.g. `["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Users\\me\\bin\\claude-glm"]`.
- `model`, `effort`: what it runs when a call names neither; a call's own reach it as `--model` and `--effort`.
- Its models count in `models.json` as `<name>/<model>`, a context tag such as `[1m]` dropped, so `models.json` (yours
  in `~/.config/crew/`) needs a group with `"provider": "<name>"` and prices for its models; `<name>/default` is the
  model it runs when neither names one.

Web access and helper agents are off by default. `web: true` permits web access; `helpers: true` permits Codex and
Antigravity reviewers to run helpers. Web access lets a reviewer send information from the files it reads to a URL.

`changes` adds a Git diff to the brief: `"uncommitted"`, `{ "base": "<branch>" }` or `{ "commit": "<sha>" }`.
It uses the first resolved read path's repository.

### Sidebar and limits

The crew drawer has Running, Usage, Limits and Log tabs. It shows reviews and Claude agents, their reported token
usage and estimated costs, and the main chat's usage separately. Rows open details; running reviewers can be stopped.

Limits count reviewers and Claude agents together by model group, per session. Once recorded spending reaches a
group's limit, new reviews, follow-ups and agent starts in that group are refused. Work already running can pass the
limit. The main chat's usage is shown separately and does not count against these limits.

Limits are dollars calculated from the prices in `models.json`. They are not readings of the providers' remaining
quota. The shipped limits are $12 for Claude, $4 for Codex and $2 for Argon; groups without a limit use
`limit_group_usd`, whose default is $10.

In Limits, raise a group's allowance by $1 or $10, turn spending limits off, or switch providers and Claude agents
off separately. These choices hold for the session. Run and session records are kept under `~/.cache/crew` and loaded
again on resume.

## Settings

- `codex_bin`, `agy_bin` and `claude_bin`: command or absolute path, default `codex`, `agy` and `claude`.
- `reviewers`: default provider list; it can name reviewers from `reviewers.json`.
- `codex_model`, `agy_model`, `claude_model`: default models. Empty leaves the choice to the provider; Claude defaults
  to `opus`.
- `codex_effort`, `agy_effort`, `claude_effort`: default effort. Codex and Claude default to `medium`; Antigravity is
  empty; empty leaves the effort to the provider's own default.
- `reviewer_rules`: absolute paths of Markdown files added to every reviewer's instructions.
- `timeout_s`: reviewer timeout, default 1800 seconds.
- `limit_group_usd`: fallback spending limit for groups without one in the catalog.

`models.json` holds quota groups, aliases and token prices. Entries in `~/.config/crew/models.json` replace shipped
entries of the same name. Codex's app-server supplies additional model and quota-group information at session start;
if it cannot be read, the file's catalog remains in use.

## Test

```sh
claude plugin test && claude plugin validate .
```

## Licence

MIT, see [LICENSE](LICENSE).
