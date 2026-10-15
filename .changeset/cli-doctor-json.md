---
"e2e": patch
---

Add `e2e doctor [--json]`, a cheap preflight for the host. It reports Node.js suitability, the resolved config and its targets, and required model credentials, without starting an app or calling a model. The JSON shape is stable for hosts that gate tasks on it.
