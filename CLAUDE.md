# Mail MCP workspace

## Checking mail: never look only in INBOX

Incoming mail is routed out of INBOX by the workflow router, so INBOX is
usually stale and an INBOX-only check reports "no new mail" while mail is
arriving. On the `work` account (zabolotnii@cbs.mpg.de) delivery folders are:

- `Additional` — the bulk of routed incoming mail, and where the newest
  messages normally land
- `Active/*` — topic groups (Research, Events, Facilities, IT, Deadlines, …)
- `Important` — high-signal mail
- `Pending/*` — awaiting triage by the `email-review-pending` skill

Answer any "what's new / any new email" question by listing mailboxes first
(`list_mailboxes`), then checking the delivery folders by date. Filtering on
unread status alone is also unreliable: routed mail can already be marked read.

Exclude Sent, Drafts, Trash, and Junk from "incoming mail".
