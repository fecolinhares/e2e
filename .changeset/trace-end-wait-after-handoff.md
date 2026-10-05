---
"e2e": patch
---

A recorded step the cache handed to the agent and the agent settled without acting no longer records a longer end wait on every run. The end wait is now measured from the hand-off when there was one, so the replay wait and the agent's turn no longer accumulate into it (and into the next replay's wait).
