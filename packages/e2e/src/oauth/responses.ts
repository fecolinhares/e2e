/** Helpers shared by the subscription models that ride the Responses API. */

import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';

/**
 * Tells the SDK what a subscription backend enforces: nothing is stored
 * server side. Believing storage is on, the SDK refers back to an earlier
 * turn's reasoning by id (`item_reference`), which the backend then cannot
 * find; told it is off, the SDK carries the encrypted reasoning itself.
 */
export function withoutServerStorage(model: LanguageModelV4): LanguageModelV4 {
  const storeOff = (options: LanguageModelV4CallOptions): LanguageModelV4CallOptions => ({
    ...options,
    providerOptions: { ...options.providerOptions, openai: { ...options.providerOptions?.['openai'], store: false } },
  });
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    get supportedUrls() {
      return model.supportedUrls;
    },
    doGenerate: (options) => model.doGenerate(storeOff(options)),
    doStream: (options) => model.doStream(storeOff(options)),
  };
}
