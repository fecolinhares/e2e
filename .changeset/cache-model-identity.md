---
"e2e": patch
---

`agent.act()` trace-cache keys now include the configured agent's model id (provider/model). Swapping the configured model between runs no longer silently replays a recording made under another model; non-strict runs perform model calls, while strict file-backed caches report `REPLAY_STALE`.
