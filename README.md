# cc-crew

Independent reviews for Claude Code, from Codex, Antigravity and Claude subagents. Each gets a separate conversation,
a self-contained brief and a set of paths it may read. Reports go into the project, and background results come back
into the session through cc-conversation.

Provided as is.

## Requirements

- Claude Code 2.1.296 or later. The sidebar needs fullscreen rendering; outside fullscreen nothing is drawn.
- [cc-sidebar](https://github.com/wfthkttn/cc-sidebar) and
  [cc-conversation](https://github.com/wfthkttn/cc-conversation).
- The Codex CLI for Codex reviewers, and for the sandbox around Claude reviewers' shell commands on Unix.
- The Antigravity CLI, `agy`, for Antigravity reviewers. Its reviewer is disabled on Windows.
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
Claude's Read calls are checked against resolved paths, and its shell commands run through Codex's sandbox. On
Windows, Claude reviewers have listing and search tools instead of a shell.

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

- `codex_bin` and `agy_bin`: command or absolute path, default `codex` and `agy`.
- `reviewers`: default provider list.
- `codex_model`, `agy_model`, `claude_model`: default models. Empty leaves the choice to the provider; Claude defaults
  to `opus`.
- `codex_effort`, `agy_effort`, `claude_effort`: default effort. Codex and Claude default to `medium`; Antigravity is
  empty. Claude's effort is set for its reviewer types, rather than per call.
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
