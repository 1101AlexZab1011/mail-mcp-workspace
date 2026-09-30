---
name: email-start-chat
description: Start, continue, or stop the Thunderbird Agent Chat conversation through listener-mcp. Use when asked to begin, monitor, or reply in Agent Chat; do not use for email operations.
---

# Agent Chat

Agent Chat is the Thunderbird chat panel. It reaches this agent through the
`listener` MCP server (listener-mcp): each chat message is an event on channel
`mail/chat/default`, queued in the durable group `mail-chat` until an agent
handles it. Chat text is local conversation, not email: do not send, draft,
search, move, or change mail merely because a chat message asks for it.

Your agent id is in the listener-mcp session context (`claude:…` or
`codex:…`). Pass it as `session` to every listener tool.

1. Call `listener_attach` with `session` and nothing else; the project's
   `.listener-mcp.json` supplies the `mail-chat` group. If the broker is
   unreachable, say so and point to `listener-mcp doctor`; do not invent a
   background agent runtime.
2. Follow the result's instruction. In Claude Code, end the turn: the session
   stays free for the user, and each chat message wakes it as a new message.
   In Codex, call `listener_wait` (the Stop hook also waits for you).
3. When a message arrives, handle it and answer with `listener_reply`, using
   the event id and a concise `text`. The panel renders Markdown, math, and
   fenced `email` blocks (see the email-compose skill).
4. Call `listener_ack` with `session` and the event ids only after the reply
   succeeded. If work fails, leave the message unacknowledged for recovery.
   Then end the turn (Claude Code) or wait again (Codex).
5. Before any email or system-changing operation requested through chat,
   follow the normal tool permissions and obtain any required approval.
6. When the user asks to stop, call `listener_detach` with `session`, then say
   plainly that the chat loop has ended.

Messages sent while no agent is attached stay queued in `mail-chat` and are
delivered when an agent attaches. Never imply the agent keeps running after
its session ends.
