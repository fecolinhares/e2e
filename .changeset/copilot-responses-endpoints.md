---
"e2e": minor
---

`copilot()` reaches the models Copilot serves only over its Responses API, such as `gpt-6-luna`, `gpt-5.3-codex`, and `grok-4.5`. On the first call it reads the plan's model listing and picks chat completions or the Responses API from the model's `supported_endpoints`; a model served over chat completions, or one the listing does not place, stays on chat completions. A listing that cannot be read sends that call over chat completions without remembering it, and a revoked login fails on the listing with the sign-in command. Responses models run through `@ai-sdk/openai`, which `e2e init` now adds for Copilot; without it the call names the package to install. Responses turns carry the same initiator and vision headers as chat turns. `e2e models github-copilot` marks what `copilot()` cannot call with `no chat or responses` in place of `no chat completions`, and a disabled model as `not enabled` only.
