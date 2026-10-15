---
"e2e": patch
---

Add `e2e doctor [--json]`, a cheap preflight for the host. It reports Node.js suitability, config status and targets, and checks for missing `AI_GATEWAY_API_KEY` and `OPENROUTER_API_KEY` when those names appear in the config source, without starting an app or calling a model. The JSON shape is stable for hosts that gate tasks on it.
