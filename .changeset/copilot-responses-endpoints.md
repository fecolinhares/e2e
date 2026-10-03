---
"e2e": minor
---

`copilot()` reaches the models Copilot serves only over its Responses API, such as `gpt-6-luna`. It reads the plan's model listing on the first call and picks chat completions or the Responses API for each model; a listing that cannot be read, a model it does not name, or one served over chat completions keeps chat completions, so nothing that used to work changes. A model served only over Responses is called through `@ai-sdk/openai`, which installs beside `@ai-sdk/openai-compatible`. `sendCopilotRequest` reads the turn's initiator and images from a Responses body (`input[]` with `input_image`) as well as a chat one, so those turns stop being labelled agent with no vision. `e2e models github-copilot` marks what `copilot()` cannot call with `no chat or responses` in place of `no chat completions`.
