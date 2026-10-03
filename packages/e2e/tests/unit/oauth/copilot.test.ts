import { generateText, tool } from 'ai';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotBaseUrl, copilotProtocolFor, createCopilotProvider, enterpriseHost } from '../../../src/oauth/providers/github-copilot.ts';
import { copilot } from '../../../src/oauth/copilot.ts';
import { sendCopilotRequest } from '../../../src/oauth/providers/github-copilot.ts';
import { echoUpstream, json, useServers, useVendor, type Echo, type Received } from './helpers/server.ts';

const serve = useServers(afterEach);
const vendor = useVendor(afterEach);
const noCli = async () => undefined;

describe('Copilot login', () => {
  it('runs GitHub\'s device flow with the caller\'s OAuth App and stores a non-expiring token', async () => {
    let polls = 0;
    const github = await serve((request, response) => {
      if (request.url === '/login/device/code') {
        expect(new URLSearchParams(request.body).get('client_id')).toBe('Iv23_my_app');
        return json(response, 200, { device_code: 'dc', user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0.001 });
      }
      expect(request.url).toBe('/login/oauth/access_token');
      const form = new URLSearchParams(request.body);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(form.get('client_id')).toBe('Iv23_my_app');
      expect(form.get('device_code')).toBe('dc');
      polls += 1;
      // GitHub answers pending with 200 and an error field.
      json(response, 200, polls < 3 ? { error: 'authorization_pending' } : { access_token: 'gho_token', token_type: 'bearer', scope: 'read:user' });
    });
    const provider = createCopilotProvider({ githubUrl: github.url, githubCliToken: noCli });
    let shown: unknown;
    const credentials = await provider.login({ onAuth: (info) => (shown = info), onPrompt: async () => '' }, { clientId: 'Iv23_my_app', enterpriseUrl: 'https://gh.acme.com/' });
    expect(shown).toMatchObject({ url: 'https://github.com/login/device', userCode: 'WXYZ-1234' });
    expect(credentials).toEqual({ access: 'gho_token', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' });
  });

  it('reuses the GitHub CLI token by default, and explains what it needs when there is none', async () => {
    const withCli = createCopilotProvider({ githubCliToken: async (hostname) => (hostname === undefined ? 'gho_cli' : undefined) });
    expect(await withCli.login({ onAuth() {}, onPrompt: async () => '' }, {})).toEqual({ access: 'gho_cli', refresh: '', expires: 0 });
    await expect(withCli.login({ onAuth() {}, onPrompt: async () => '' }, { enterpriseUrl: 'gh.acme.com' })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    await expect(withCli.login({ onAuth() {}, onPrompt: async () => '' }, { clientId: 'Iv23', fromGitHubCli: true })).resolves.toMatchObject({ access: 'gho_cli' });
    await expect(createCopilotProvider({ githubCliToken: noCli }).login({ onAuth() {}, onPrompt: async () => '' }, {})).rejects.toMatchObject({ code: 'MISCONFIGURED' });
  });

  it('cannot refresh: a rejected token means signing in again', async () => {
    await expect(createCopilotProvider().refresh({ access: 'x', refresh: '', expires: 0 })).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('derives the enterprise API host and refuses anything but a plain hostname', async () => {
    expect(copilotBaseUrl()).toBe('https://api.githubcopilot.com');
    expect(copilotBaseUrl('https://github.acme.com/')).toBe('https://copilot-api.github.acme.com');
    expect(enterpriseHost('GitHub.Acme.com')).toBe('github.acme.com');
    for (const bad of ['evil.com@github.acme.com', 'github.acme.com/path', 'github.acme.com?x=1', 'github.acme.com:8443', 'http://github.acme.com', 'not a host', 'localhost']) {
      expect(() => enterpriseHost(bad), bad).toThrow(/not a GitHub Enterprise host/);
    }
    const provider = createCopilotProvider({ githubCliToken: async () => 'gho' });
    await expect(provider.login({ onAuth() {}, onPrompt: async () => '' }, { enterpriseUrl: 'evil.com@github.acme.com' })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
  });
});

describe('Copilot requests', () => {
  it('marks agent turns and image requests, and routes an enterprise login at its host', async () => {
    const withImage = new Request('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }, { role: 'assistant', content: 'ok' }] }),
    });
    const sent = (await (await sendCopilotRequest(withImage, { access: 'a', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' }, echoUpstream)).json()) as Echo;
    expect(sent.url).toBe('https://copilot-api.gh.acme.com/chat/completions');
    expect(sent.headers).toMatchObject({ 'x-initiator': 'agent', 'copilot-vision-request': 'true', 'openai-intent': 'conversation-edits' });
    const plain = new Request('https://api.githubcopilot.com/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    const sentPlain = (await (await sendCopilotRequest(plain, { access: 'a', refresh: '', expires: 0 }, echoUpstream)).json()) as Echo;
    expect(sentPlain.url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(sentPlain.headers['x-initiator']).toBe('user');
    expect(sentPlain.headers['copilot-vision-request']).toBeUndefined();
  });

  it('serves generateText over the chat protocol with the stored GitHub token', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      seen = request;
      json(response, 200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4.1',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'report', arguments: '{"color":"red"}' } }] } }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('gpt-4.1');
    expect(model).toMatchObject({ provider: 'github-copilot.chat', modelId: 'gpt-4.1' });
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'color?' }, { type: 'file', data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' }] }],
      tools: { report: tool({ inputSchema: z.object({ color: z.string() }) }) },
      toolChoice: { type: 'tool', toolName: 'report' },
    });
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'report', input: { color: 'red' } });
    expect(seen!.url).toBe('/chat/completions');
    expect(seen!.headers['authorization']).toBe('Bearer gho_x');
    expect(seen!.headers['copilot-vision-request']).toBe('true');
  });

  it('marks agent turns and image requests from a Responses body too', async () => {
    const withImage = new Request('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({
        model: 'gpt-6-luna',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'x' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }] },
          { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        ],
      }),
    });
    const sent = (await (await sendCopilotRequest(withImage, { access: 'a', refresh: '', expires: 0, enterpriseUrl: 'gh.acme.com' }, echoUpstream)).json()) as Echo;
    expect(sent.url).toBe('https://copilot-api.gh.acme.com/responses');
    expect(sent.headers).toMatchObject({ 'x-initiator': 'agent', 'copilot-vision-request': 'true', 'openai-intent': 'conversation-edits' });
    const plain = new Request('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
    });
    const sentPlain = (await (await sendCopilotRequest(plain, { access: 'a', refresh: '', expires: 0 }, echoUpstream)).json()) as Echo;
    expect(sentPlain.headers['x-initiator']).toBe('user');
    expect(sentPlain.headers['copilot-vision-request']).toBeUndefined();
  });

  it('names the login command when GitHub rejects the stored token, which has nothing to refresh it', async () => {
    const api = await serve((_request, response) => json(response, 401, { message: 'Bad credentials' }));
    vendor(api, { 'github-copilot': { access: 'gho_revoked', refresh: '', expires: 0 } });
    const model = copilot('gpt-4.1');
    await expect(generateText({ model, prompt: 'color?' })).rejects.toMatchObject({
      code: 'LOGIN_REQUIRED',
      message: 'GitHub Copilot rejected the stored token (401: Bad credentials); run `npx e2e login github-copilot`',
    });
    // The model listing is asked once before the call; the rejected token is not retried.
    expect(api.requests.filter((request) => request.url === '/chat/completions')).toHaveLength(1);
  });

  it('calls an enabled model Copilot lists only over Responses through the Responses API, with no server storage', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      if (request.url === '/models') {
        json(response, 200, {
          data: [{ id: 'gpt-6-luna', vendor: 'OpenAI', policy: { state: 'enabled' }, supported_endpoints: ['/responses', 'ws:/responses'], capabilities: { type: 'chat' } }],
        });
        return;
      }
      seen = request;
      json(response, 200, {
        id: 'resp_1',
        created_at: 1,
        model: 'gpt-6-luna',
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'luna', annotations: [] }] }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      });
    });
    vendor(api, { 'github-copilot': { access: 'gho_x', refresh: '', expires: 0 } });
    const model = copilot('gpt-6-luna');
    // Before the first call the delegate reads as its chat model; the listing settles it.
    expect(model).toMatchObject({ provider: 'github-copilot.chat', modelId: 'gpt-6-luna' });
    const result = await generateText({ model, prompt: 'color?' });
    expect(result.text).toBe('luna');
    expect(model.provider).toBe('github-copilot.responses');
    expect(seen!.url).toBe('/responses');
    expect(seen!.headers['authorization']).toBe('Bearer gho_x');
    const body = JSON.parse(seen!.body) as { input?: unknown; messages?: unknown; store?: unknown };
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.messages).toBeUndefined();
    expect(body.store).toBe(false);
  });

  it('lists the chat models of the plan through the login, leaving embeddings out and marking what copilot() cannot use', async () => {
    let seen: Received | undefined;
    const api = await serve((request, response) => {
      seen = request;
      json(response, 200, {
        data: [
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', capabilities: { type: 'chat', supports: { tool_calls: true, vision: true } } },
          { id: 'text-embedding-3-small', name: 'Embedding', vendor: 'Azure OpenAI', capabilities: { type: 'embeddings' } },
          { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'OpenAI', preview: true, capabilities: { type: 'chat', supports: { tool_calls: true } } },
          { id: 'claude-haiku-4.5', vendor: 'Anthropic', policy: { state: 'enabled' }, supported_endpoints: ['/chat/completions', '/v1/messages'], capabilities: { type: 'chat' } },
          { id: 'claude-opus-5', vendor: 'Anthropic', policy: { state: 'disabled' }, supported_endpoints: ['/v1/messages', '/chat/completions'], capabilities: { type: 'chat' } },
          { id: 'claude-fable-5.1', vendor: 'Anthropic', policy: { state: 'unconfigured' }, capabilities: { type: 'chat' } },
          { id: 'claude-messages', vendor: 'Anthropic', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat' } },
          { id: 'gpt-6-luna', vendor: 'OpenAI', policy: { state: 'enabled' }, supported_endpoints: ['/responses', 'ws:/responses'], capabilities: { type: 'chat' } },
          { id: 'gpt-5.5', vendor: 'OpenAI', policy: { state: 'disabled' }, supported_endpoints: ['/responses'], capabilities: { type: 'chat' } },
        ],
      });
    });
    const provider = createCopilotProvider();
    const models = await provider.models!(async (input, init) => {
      const request = new Request(input, init);
      const rerouted = new Request(request.url.replace('https://api.githubcopilot.com', api.url), request);
      return sendCopilotRequest(rerouted, { access: 'gho_x', refresh: '', expires: 0 }, fetch);
    });
    expect(seen!.url).toBe('/models');
    expect(seen!.headers['openai-intent']).toBe('conversation-edits');
    expect(models).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', detail: 'Anthropic, tools, vision' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', detail: 'OpenAI, tools, preview' },
      { id: 'claude-haiku-4.5', detail: 'Anthropic' },
      { id: 'claude-opus-5', detail: 'Anthropic, not enabled' },
      { id: 'claude-fable-5.1', detail: 'Anthropic, not enabled' },
      { id: 'claude-messages', detail: 'Anthropic, no chat or responses' },
      { id: 'gpt-6-luna', detail: 'OpenAI' },
      { id: 'gpt-5.5', detail: 'OpenAI, not enabled, no chat or responses' },
    ]);
  });
});

describe('Copilot endpoint selection', () => {
  it('rejects an aborted lookup instead of reading it as a missing endpoint', async () => {
    const controller = new AbortController();
    controller.abort();
    // A fetch that honours the signal the way the real one does: aborted means rejected.
    const onAbort = (request: Request) =>
      request.signal.aborted ? Promise.reject(new Error('aborted')) : new Promise<Response>(() => {});
    await expect(copilotProtocolFor('m', onAbort as never, controller.signal)).rejects.toThrow('aborted');
    // Without a signal the same lookup would have been read as a missing endpoint.
    expect(await copilotProtocolFor('m', (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as never)).toBe('chat');
  });

  const listing = (data: unknown, status = 200) => async () => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  const entry = (supported: string[], policy?: { state: string }) => ({ id: 'm', ...(policy === undefined ? {} : { policy }), supported_endpoints: supported });

  it('keeps a model that lists chat completions on chat, unchanged', async () => {
    expect(await copilotProtocolFor('m', listing([entry(['/chat/completions', '/v1/messages'])]))).toBe('chat');
  });

  it('routes an enabled model served only over Responses to the Responses API', async () => {
    expect(await copilotProtocolFor('m', listing([{ id: 'm', policy: { state: 'enabled' }, supported_endpoints: ['/responses', 'ws:/responses'] }]))).toBe('responses');
  });

  it('falls back to chat whenever the endpoint cannot be established', async () => {
    const cases: Array<[string, unknown, number]> = [
      ['chat named beside responses', [entry(['/responses', '/chat/completions'], { state: 'enabled' })], 200],
      ['no supported_endpoints', [{ id: 'm', policy: { state: 'enabled' } }], 200],
      ['responses but not enabled', [entry(['/responses'], { state: 'disabled' })], 200],
      ['responses with no policy at all', [entry(['/responses'])], 200],
      ['another endpoint only', [entry(['/v1/messages'], { state: 'enabled' })], 200],
      ['the model is not in the listing', [{ id: 'other', policy: { state: 'enabled' }, supported_endpoints: ['/responses'] }], 200],
      ['the listing is not ok', [entry(['/responses'], { state: 'enabled' })], 500],
    ];
    for (const [name, data, status] of cases) expect(await copilotProtocolFor('m', listing(data, status)), name).toBe('chat');
    expect(await copilotProtocolFor('m', async () => { throw new Error('offline'); })).toBe('chat');
    expect(await copilotProtocolFor('m', async () => new Response('not json'))).toBe('chat');
  });
});
