---
name: email-start-chat
description: Start or continue a local Thunderbird Agent Chat conversation through the mail-agent-chat MCP server. Use when asked to begin, monitor, or reply in Agent Chat; do not use for email operations.
---

# Agent Chat

Use the `mail-agent-chat` MCP server. Agent Chat is local conversation text,
not email: do not send, draft, search, move, or change mail merely because a
chat message asks for it.

1. Call `start_chat_listener`. If it reports that the user service is not
   installed, explain the required local installation command; do not attempt
   to invent a background agent runtime.
2. Enter the monitoring loop: call `wait_for_chat_message` with no
   `wait_seconds`. The default of -1 never times out, so the call returns only
   when a message actually arrives; there is no empty polling result to handle. Do not finish, report that there
   are no messages, or claim to monitor chat unless a wait call is outstanding.
3. When a message arrives, handle it, then call `send_to_chat` with a concise
   response in the same `conversation_id`.
4. Call `acknowledge_chat_message` only after the response is successfully
   delivered. If work fails, leave the message unacknowledged for recovery.
   Then resume the monitoring loop at step 2.
5. Before any separate email or system-changing operation requested through
   chat, follow the normal tool permissions and obtain any required approval.

The listener stores queued messages while no agent is connected. The listener
service stays up independently; the active agent waits for messages and resumes
waiting after each reply. State clearly when the monitoring loop ends; never
imply background LLM availability after the session ends.
