# Independent chats

`orx agent spawn` now creates an ordinary chat using your saved New Chat settings,
just like opening a new chat in the project and submitting a message. Created
chats no longer have an owner or helper restrictions, and do not send completion
replies back to the creating chat. Existing chats, edits, and transcripts are
preserved; undelivered opening messages move to the normal message queue.
Outstanding legacy creator wakeups are discontinued.

Use `--project <project-id>` when there is no current OpenResearch chat context.
`--harness`, `--model`, and `--no-wake` are no longer supported. Configure new-chat
settings in OpenResearch instead. The user's current view stays selected.

## MobileSci product compatibility

Research expert tasks continue to use `orx research dispatch`, with registered
plans, approval gates, inherited execution settings and completion reports.
Ordinary `orx agent spawn` cannot bypass this workflow from a research session.
The product retains the legacy scheduler table for expert tasks and binary
rollback; only ordinary legacy dispatches migrate to independent chats.
