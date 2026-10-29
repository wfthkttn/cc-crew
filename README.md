# cc-crew

Jobs for Claude Code run by other providers' models: a review of code, research on a question, or any job you define,
each behind one tool. The agent calling it says what it wants and what may be read; which models run it, on which
provider and how is crew's configuration. Results come back into the session through cc-conversation and are read
through crew's tools. Its sidebar tab shows the session's jobs and Claude agents, what they spent, the limits on them
and each provider's quota.

Provided as is.

## Requirements

- Claude Code 2.1.296 or later. The sidebar needs fullscreen rendering; outside fullscreen nothing is drawn.
- [cc-sidebar](https://github.com/wfthkttn/cc-sidebar), [cc-conversation](https://github.com/wfthkttn/cc-conversation),
  [cc-providers](https://github.com/wfthkttn/cc-providers) and [cc-agents](https://github.com/wfthkttn/cc-agents).
  cc-providers runs the agents, so its requirements hold for them: the Codex CLI signed
  in for Codex, `agy` signed in for Antigravity, Claude Code signed in to Claude for a Claude agent.
- [cc-bus](https://github.com/wfthkttn/cc-bus). For Telegram asks, a mod that carries cc-bus's `person.ask` to the
  person, such as cc-courier (optional): without one a paused conversation is told in the terminal.

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

Each job in crew's configuration is a tool of its name. Two ship:

- `mcp__cc-crew__review` takes `prompt`, the brief, `paths`, what its agents may read, and optionally `diff`.
- `mcp__cc-crew__research` takes `prompt` and optionally `paths`; without them its agents read nothing on disk.

Agents do not get this session's conversation. A call names no model, provider, effort or other setting; one that does
is refused, saying what the tool takes. Every agent of a job runs in the background as a cc-agents run, and one's
failure leaves the others running. The tool returns the job's id, `review-1` and on per session, and a message arrives
once every agent ended.

Three more tools work on any job:

- `jobs` lists what runs and what finished unread, with how each agent is doing.
- `report { id, scope?, findings_only? }` reads a report. A whole read marks it read; `scope` shows that scope alone and
  `findings_only` just the findings and their references, and neither marks it. A job of an earlier session is read by
  its full id, `<session>/review-1`.
- `stop { id, agent? }` stops a job or one of its agents; what the others found is kept.

A report goes by scope, what system it speaks of, each with its report, findings and references. Agents' scopes of one
name join and their findings are listed as given, unmerged; a report names no model, which the sidebar's details do.
Reports are written under `~/.claude/crew/<session id>/<job>-N` (`$CLAUDE_CONFIG_DIR/crew` where that is set) and are
meant to be read through `report`.

### Access

`paths` are files and directories, relative to the project; `"."` is the project. cc-providers resolves them, denies
secret files by name (`.env`, private keys, credential files; this does not find secrets stored under other names) and
holds each harness to them. A job's `web` lets its agents reach the web, which also lets them send what they read to a
URL; `helpers` lets Codex and Antigravity agents run helpers. Shipped, `research` has the web and `review` does not.

`diff` adds a Git diff to the brief: `"uncommitted"`, `{ "base": "<branch>" }` or `{ "commit": "<sha>" }`. It uses the
repository of the first path the call names, and only the changes under the paths; files cc-providers marks secret are
left out of it.

### Watching a job

Every minute crew reads each running agent's events. An agent with one tool call open past its stall limit, or silent
past it, is told to the main agent as soon as that is idle, naming the call and for how long, once per call or silence;
`jobs` shows the same. An agent that ends badly is told as it happens, and a job past its poke time is told as a status
if nothing else was. The main agent decides whether to `stop` it. An agent past its timeout is ended.

### Sidebar, limits and quota

The crew drawer has Running, Jobs, Usage, Limits, Quota and Log tabs. It shows jobs and Claude agents, their reported
token usage and costs, and the main chat's spend. Rows open details; running agents can be stopped. In Jobs, each job's
models can be ticked or unticked and their poke time moved. Both hold for this session, past a reload.

Limits are cc-providers', per session and per pool: helpers (job agents and Claude's agents) past theirs are refused;
the conversation past its own is paused but for turns the person starts. In Limits, raise either by $1 or $10, turn
the limits off, or switch off each provider, or Claude agents. These hold for the session.

When the conversation is paused in a pool, the tab's badge turns red and crew asks on Telegram whether to raise its
limit by $1 or $10 or keep it paused; with nobody to carry the ask, or a thread that is off, the terminal and the
thread get a notice. An answer that arrives after crew reloaded is still acted on.

The tab draws the quota of the first three providers that read or meter one as bars, the short window beside the
weekly one; the Quota tab lists every window of every pool.

Session records are kept under `~/.cache/crew` and loaded again on resume.

## Jobs

The jobs ship in `crew.json`; `~/.config/crew/crew.json` changes a job field by field, adds models to it, or adds a job:

```json
{
  "jobs": {
    "review": {
      "models": { "openai/gpt-6.1-terra": { "effort": "high", "pokeMin": 40 } },
      "default": ["google/gemini-3.8-flash", "openai/gpt-6.1-terra"],
      "bySessionModel": { "claude/opus": ["openai/gpt-6.1-terra"] }
    }
  }
}
```

A job has:

- `description`: what the tool tells the agent; `prompt`: the instructions its agents get, a Markdown file found from
  the folder of the crew file that names it. crew adds the report format and the person's rules to them.
- `kind`: a cc-agents kind. The shipped jobs are `oneshot`.
- `web`, `helpers`; `paths`: `"required"` or `"optional"`; `diff`: whether its tool takes `diff`.
- `timeoutMin`, `pokeMin`, `stallMin`: when an agent is ended, when a running job is told, how long one call or silence
  may last before it is told.
- `models`: what can run it, by the vendor's model (`<vendor>/<model>`, the `serves` of a cc-providers offer), each with
  `effort`, `provider` or its own values of `web`, `helpers`, `timeoutMin`, `pokeMin`, `stallMin`.
- `default`: the models that run it, and `bySessionModel`: other lists by the session's model as cc-providers keys it
  (`claude/opus`).

cc-providers picks the provider for each model at each start: quota left first, a pool whose quota nobody reads next,
API billing per token last, the cheapest within each. A model with no provider able to run it now is left out and the
person told; a job with none left is refused, saying why.

Shipped: `review` runs Gemini Flash and GLM, and Sonnet, Gemini Argon and GPT Sol for Opus and Fable sessions;
`research` runs Gemini Flash.

## Settings

- `reviewer_rules`: absolute paths of Markdown files added to every crew agent's instructions.

Commands, models, prices, pools and limits are cc-providers' (`providers.json`).

## Test

```sh
claude plugin test && claude plugin validate .
```

## Licence

MIT, see [LICENSE](LICENSE).
