import { describe, expect, it } from 'vitest';
import { CAMPAIGN_TOOLS, campaignSystemPrompt, campaignUserMessage, mockCampaignTurn } from './agents/campaign';
import { FailoverAIProvider } from './providers/failover';
import { MockAIProvider } from './providers/mock';
import { OpenAIProvider } from './providers/openai';
import type { AgentMessage, AIProvider } from './providers/types';

describe('tool calling (OpenAI-compatible)', () => {
  it('sends tools and the conversation in the standard format and reads tool calls back', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"prices"}' } }] } }], usage: { prompt_tokens: 50, completion_tokens: 10 } }), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'meta', fetchImpl });
    const messages: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c0', name: 'get_business_profile', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c0', name: 'get_business_profile', content: '{"brandName":"Bella"}' },
    ];
    const res = await p.chatWithTools({ messages, tools: CAMPAIGN_TOOLS });
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_knowledge', arguments: '{"query":"prices"}' }]);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    expect(body.tool_choice).toBe('auto');
    expect((body.tools as { type: string; function: { name: string } }[]).map((t) => t.function.name)).toContain('create_post_draft');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'goal' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'get_business_profile', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c0', content: '{"brandName":"Bella"}' },
    ]);
    expect(body.reasoning_effort).toBe('low');
  });

  it("returns Gemini's thought signature with the tool call on the next turn", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sig = { google: { thought_signature: 'sig-abc' } };
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ model: 'gemini', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'g1', type: 'function', function: { name: 'get_business_profile', arguments: '{}' }, extra_content: sig }] } }] }), { status: 200 });
    }) as typeof fetch;
    const p = new OpenAIProvider({ apiKey: 'k', kind: 'google', fetchImpl });
    const first = await p.chatWithTools({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: CAMPAIGN_TOOLS });
    expect(first.toolCalls[0]!.extra).toEqual(sig);
    await p.chatWithTools({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: null, toolCalls: first.toolCalls }, { role: 'tool', toolCallId: 'g1', name: 'get_business_profile', content: '{}' }], tools: CAMPAIGN_TOOLS });
    const echoed = (bodies[1]!.messages as { tool_calls?: { extra_content?: unknown }[] }[])[2]!.tool_calls![0]!;
    expect(echoed.extra_content).toEqual(sig);
  });

  it('fails over past a provider without tool calling, without blocking its other calls', async () => {
    const noTools: AIProvider = { name: 'notools', modelFor: () => 'x', generateText: async () => ({ text: 'ok', model: 'x', usage: {} }), generateStructured: async () => { throw new Error('unused'); } };
    const chain = new FailoverAIProvider([noTools, new MockAIProvider()]);
    const res = await chain.chatWithTools({ messages: [{ role: 'system', content: campaignSystemPrompt({ goal: 'g', startDate: '2026-11-01', days: 7, maxPosts: 3 }) }, { role: 'user', content: campaignUserMessage({ goal: 'g', startDate: '2026-11-01', days: 7, maxPosts: 3 }) }], tools: CAMPAIGN_TOOLS });
    expect(res.provider).toBe('mock');
    expect((await chain.generateText({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).provider).toBe('notools');
  });
});

describe('offline Campaign Agent', () => {
  it('works through profile, knowledge, recent posts, a form, posts, images and finish', () => {
    const brief = { goal: 'Fill our weekend baking classes', startDate: '2026-11-02', days: 7, maxPosts: 5 };
    const messages: AgentMessage[] = [{ role: 'system', content: campaignSystemPrompt(brief) }, { role: 'user', content: campaignUserMessage(brief) }];
    const results: Record<string, (args: Record<string, unknown>, i: number) => unknown> = {
      get_business_profile: () => ({ brandName: "Bella's Bakery", connectedPlatforms: ['INSTAGRAM', 'FACEBOOK', 'WHATSAPP'] }),
      search_knowledge: () => ({ snippets: [] }),
      get_recent_posts: () => ({ posts: [] }),
      create_signup_form: () => ({ formId: 'f1', link: 'https://x/f/lf_1' }),
      create_post_draft: (_a, i) => ({ contentId: `c${i}` }),
      generate_post_image: () => ({ ok: true }),
    };
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const turn = mockCampaignTurn(messages);
      const call = turn.toolCalls[0]!;
      names.push(call.name);
      if (call.name === 'finish') break;
      messages.push({ role: 'assistant', content: null, toolCalls: [call] });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(results[call.name]!(JSON.parse(call.arguments), i)) });
    }
    expect(names).toEqual(['get_business_profile', 'search_knowledge', 'get_recent_posts', 'create_signup_form', 'create_post_draft', 'create_post_draft', 'create_post_draft', 'generate_post_image', 'generate_post_image', 'generate_post_image', 'finish']);
    const firstPost = JSON.parse(messages.find((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'create_post_draft')!.role === 'assistant' ? (messages.find((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'create_post_draft') as { toolCalls: { arguments: string }[] }).toolCalls[0]!.arguments : '{}');
    expect(firstPost.plannedDate).toBe('2026-11-02');
    expect(firstPost.variants.map((v: { platform: string }) => v.platform)).toEqual(['INSTAGRAM', 'FACEBOOK']); // never WhatsApp
    expect(firstPost.variants[0].caption).toContain('link in our bio');
  });
});
