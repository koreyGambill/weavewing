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
inline, like side-chat context, to the next prompt on the provider thread that split created, then
records it as delivered. A later split moves the active conversation elsewhere and leaves it unsent.
Nothing returns the summarized turns to that conversation: Bring back adds the archive as a reference,
and a merge back from the archive sends only work done there after its fork point, which is the
summary turn.
