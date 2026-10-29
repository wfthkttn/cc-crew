# cc-crew

Independent reviews for Claude Code from other providers' models: Codex, Antigravity, Claude, or any provider
cc-providers runs headless. Each gets a separate conversation, a self-contained brief and a set of paths it may read.
Reports go into the project, and background results come back into the session through cc-conversation. Its sidebar
tab shows the session's reviews and Claude agents, what they spent, the limits on them and each provider's quota.

Provided as is.

## Requirements

- Claude Code 2.1.296 or later. The sidebar needs fullscreen rendering; outside fullscreen nothing is drawn.
- [cc-sidebar](https://github.com/wfthkttn/cc-sidebar), [cc-conversation](https://github.com/wfthkttn/cc-conversation),
  cc-providers and cc-agents. cc-providers runs the reviewers, so its requirements hold for them: the Codex CLI signed
  in for Codex, `agy` signed in for Antigravity, Claude Code signed in to Claude for the Claude reviewer.
- For Telegram asks, courier (optional): without it a paused conversation is told in the terminal.

## Install

From the marketplace `wfthkttn` ([cc-mods](https://github.com/wfthkttn/cc-mods)), at a Claude Code prompt:

```
/plugin install cc-crew --marketplace wfthkttn/cc-mods
```

Answer `y` to add the marketplace, then pick a scope. Its dependencies install with it.

Or load it from a directory: the plugin is this repository's root. Clone it and list the clone in
`~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/cc-crew" }
```

Load its dependencies too, from the marketplace or their own directories.

## What it does

The tool `mcp__cc-crew__review` takes a short `description` and a `prompt` containing the brief. Reviewers do not get
this session's conversation. A call can choose its providers, models and reasoning effort; otherwise the plugin's
configured defaults apply. The default providers are Codex, Antigravity and Claude; any provider in cc-providers'
`providers.json` with a `cli:` endpoint can review.

Reviews run in parallel and in the background by default, each reviewer a cc-agents run grouped under the review.
The tool returns a run id; once every reviewer finishes, the session receives their statuses, costs and report paths.
`background: false` waits for the results instead. One reviewer's failure leaves the others running.

Reports go under `<project>/.claude/work/reviews`, in a folder for the run, with its brief and a Markdown report for
each reviewer. A custom `report_dir` must remain under `<project>/.claude/work/`. Reports include the summary,
findings, what was checked and what was not read when the reviewer returns the requested structure.

`mcp__cc-crew__review_continue` sends a follow-up to one finished reviewer in its own conversation, from the session
that started the review. Reviewers write the hour-long prompt cache where their harness can choose it, so a
follow-up within the hour reads it cheaply; the summary says until when each is warm.
`mcp__cc-crew__review_status` reports runs and the quota of each reviewer's provider.

### Read limits

`read` is `"project"` by default, `"none"` for no files, or a list of files and directories. Relative paths are
relative to the project. cc-providers resolves them, denies secret files by name (`.env`, private keys, credential
files; this does not find secrets stored under other names) and holds each harness to them.

Web access and helper agents are off by default. `web: true` permits web access; `helpers: true` permits Codex and
Antigravity reviewers to run helpers. Web access lets a reviewer send information from the files it reads to a URL.

`changes` adds a Git diff to the brief: `"uncommitted"`, `{ "base": "<branch>" }` or `{ "commit": "<sha>" }`.
It uses the repository of the first read path the call names; files cc-providers marks secret are left out of it.

### Sidebar, limits and quota

The crew drawer has Running, Usage, Limits, Quota and Log tabs. It shows reviews and Claude agents, their reported
token usage and costs, and the main chat's spend. Rows open details; running reviewers can be stopped.

Limits are cc-providers', per session and per pool: helpers (reviewers and Claude's agents) past theirs are refused;
the conversation past its own is paused but for turns the person starts. In Limits, raise either by $1 or $10, turn
the limits off, or switch providers and Claude agents off. These hold for the session.

When the conversation is paused in a pool, the tab's badge turns red and crew asks on Telegram whether to raise its
limit by $1 or $10 or keep it paused; without courier the terminal and the thread get a notice.

The tab draws the quota of the first three providers that read or meter one as bars, the short window beside the
weekly one; the Quota tab lists every window of every pool.

Review and session records are kept under `~/.cache/crew` and loaded again on resume.

## Settings

- `reviewers`: default provider list.
- `codex_model`, `agy_model`, `claude_model`: default models. Empty leaves the choice to the provider; Claude defaults
  to `opus`. Other providers run their own default.
- `codex_effort`, `agy_effort`, `claude_effort`: default effort. Codex and Claude default to `medium`; Antigravity is
  empty; empty leaves the effort to the provider's own default.
- `reviewer_rules`: absolute paths of Markdown files added to every reviewer's instructions.
- `timeout_s`: reviewer timeout, default 1800 seconds.

Commands, models, prices, pools and limits are cc-providers' (`providers.json`).

## Test

```sh
claude plugin test && claude plugin validate .
```

## Licence

MIT, see [LICENSE](LICENSE).
