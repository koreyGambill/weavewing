# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.

A rewind with a summary stores the agent's summary as a `checkpoint_summary` handoff in the same
event batch as the split, so the conversation never rewinds without one. Turn start prepends it
inline, like side-chat context, only to a prompt the user wrote, and only into the conversation the
split continued: that provider thread, or its native conversation resumed under another account.
Scheduled, merge-back and fresh-context turns leave it pending. A provider switch's history carries
the summary as one historical message, so the other provider sees it while the continued
conversation still waits for it. Recovery after a failed native resume rebuilds history without
rolled-back runs, which include a rewind's archived turns.
Nothing returns the summarized turns to that conversation: Bring back adds the archive as a reference,
and a merge back from the archive sends only work done there after its fork point, which is the
summary turn. A crash between the provider accepting a prompt and the delivery record can send the
summary twice, and a fork made before delivery starts without it.
