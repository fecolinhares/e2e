/**
 * `copilot('claude-sonnet-5')`: a GitHub Copilot subscription as an AI SDK
 * model. Copilot serves most of its models over the OpenAI chat protocol and
 * some only over its Responses API; the instance asks the plan's model
 * listing which on the first call and delegates to the matching model, so
 * construction stays synchronous and touches the network only when a call
 * does. An enterprise login stored by `e2e login` routes to its own host.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createOAuthFetch } from './fetch.ts';
import { USER_AGENT, loginHint } from './providers.ts';
import { COPILOT_API_URL, copilotProtocolFor, createCopilotProvider, type CopilotProtocol } from './providers/github-copilot.ts';
import { withoutServerStorage } from './responses.ts';
import { defaultCredentialStore } from './store.ts';

export function copilot(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createCopilotProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('github-copilot'),
  });
  // The key header is removed per request; the value only satisfies the constructor.
  const chat = createOpenAICompatible({
    name: 'github-copilot',
    baseURL: COPILOT_API_URL,
    apiKey: 'oauth',
    fetch,
    includeUsage: true,
  }).chatModel(modelId);
  return protocolDelegate(
    chat,
    async () => {
      // Imported only when a Responses model is called, so a chat-only project needs no @ai-sdk/openai install.
      const { createOpenAI } = await import('@ai-sdk/openai');
      return withoutServerStorage(createOpenAI({ apiKey: 'oauth', baseURL: COPILOT_API_URL, fetch, name: 'github-copilot' }).responses(modelId));
    },
    () => copilotProtocolFor(modelId, fetch),
  );
}

/**
 * A model that settles its Copilot protocol on the first call and delegates
 * to the model for it: chat completions, or the Responses API wrapped the way
 * the subscription backends need. The choice is cached, and a listing that
 * cannot be read resolves to chat, so the delegate never blocks construction
 * and never changes what used to work.
 */
function protocolDelegate(chat: LanguageModelV4, responses: () => Promise<LanguageModelV4>, choose: () => Promise<CopilotProtocol>): LanguageModelV4 {
  let pending: Promise<LanguageModelV4> | undefined;
  let resolved: LanguageModelV4 | undefined;
  const delegate = (): Promise<LanguageModelV4> => {
    pending ??= (async () => {
      const protocol = await choose();
      resolved = protocol === 'responses' ? await responses() : chat;
      return resolved;
    })();
    return pending;
  };
  return {
    specificationVersion: chat.specificationVersion,
    get provider() {
      return resolved?.provider ?? chat.provider;
    },
    get modelId() {
      return resolved?.modelId ?? chat.modelId;
    },
    get supportedUrls() {
      return resolved?.supportedUrls ?? chat.supportedUrls;
    },
    doGenerate: async (options) => (await delegate()).doGenerate(options),
    doStream: async (options) => (await delegate()).doStream(options),
  };
}
