/**
 * Unit tests for the Anthropic <-> OpenAI translation layer.
 * No server, no network: pure functions and a stream transform.
 */
import {
  toAnthropicRequest,
  fromAnthropicResponse,
  anthropicSseToOpenAi
} from '../src/backend/providers/anthropic-adapter';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(title: string): void {
  console.log(`\n▶ ${title}`);
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function runStream(events: any[]): Promise<string> {
  const transform = anthropicSseToOpenAi();
  const chunks: Buffer[] = [];
  transform.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  const done = new Promise<void>((resolve) => transform.on('end', () => resolve()));

  for (const event of events) {
    transform.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  transform.end();
  await done;
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  // ------------------------------------------------------------ request
  section('Request translation (OpenAI -> Anthropic)');
  const request = toAnthropicRequest({
    model: 'claude-3-5-sonnet',
    max_tokens: 256,
    temperature: 0.2,
    stop: ['END'],
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Again' }
    ]
  });

  check('model preserved', request.model === 'claude-3-5-sonnet');
  check('system extracted to top-level', request.system === 'You are terse.');
  check('max_tokens preserved', request.max_tokens === 256);
  check('temperature preserved', request.temperature === 0.2);
  check('stop mapped to stop_sequences', deepEqual(request.stop_sequences, ['END']));
  check('system removed from messages', !request.messages.some((m: any) => m.role === 'system'));
  check('message count is 3', request.messages.length === 3, String(request.messages.length));

  const defaultTokens = toAnthropicRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  check('max_tokens defaults when absent', defaultTokens.max_tokens === 1024, String(defaultTokens.max_tokens));

  const merged = toAnthropicRequest({
    model: 'x',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]
  });
  check('consecutive same-role messages merged', merged.messages.length === 1, String(merged.messages.length));

  const withTools = toAnthropicRequest({
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
      }
    ],
    tool_choice: 'auto'
  });
  check('tools translated', Array.isArray(withTools.tools) && withTools.tools[0].name === 'get_weather');
  check('tool schema preserved', withTools.tools[0].input_schema?.properties?.city?.type === 'string');
  check('tool_choice auto mapped', deepEqual(withTools.tool_choice, { type: 'auto' }));

  // ------------------------------------------------------------ response
  section('Response translation (Anthropic -> OpenAI)');
  const response = fromAnthropicResponse({
    id: 'msg_1',
    model: 'claude-3-5-sonnet',
    content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' }
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 7 }
  });

  check('object is chat.completion', response.object === 'chat.completion');
  check('content blocks joined', response.choices[0].message.content === 'Hello world');
  check('finish_reason end_turn -> stop', response.choices[0].finish_reason === 'stop');
  check('usage prompt tokens', response.usage.prompt_tokens === 12);
  check('usage completion tokens', response.usage.completion_tokens === 7);
  check('usage total computed', response.usage.total_tokens === 19);

  const toolResponse = fromAnthropicResponse({
    id: 'msg_2',
    model: 'claude',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 5, output_tokens: 3 }
  });
  check('tool_use -> tool_calls', Array.isArray(toolResponse.choices[0].message.tool_calls));
  check('tool call name preserved', toolResponse.choices[0].message.tool_calls[0].function.name === 'get_weather');
  check('tool args stringified', JSON.parse(toolResponse.choices[0].message.tool_calls[0].function.arguments).city === 'Paris');
  check('finish_reason tool_use -> tool_calls', toolResponse.choices[0].finish_reason === 'tool_calls');

  const maxTokens = fromAnthropicResponse({ content: [], stop_reason: 'max_tokens', usage: {} });
  check('finish_reason max_tokens -> length', maxTokens.choices[0].finish_reason === 'length');

  // ------------------------------------------------------------ stream
  section('Streaming translation (Anthropic SSE -> OpenAI chunks)');
  const streamed = await runStream([
    { type: 'message_start', message: { id: 'msg_3', model: 'claude-3', usage: { input_tokens: 9 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' }
  ]);

  check('emits SSE data lines', streamed.includes('data: {'));
  check('contains first delta', streamed.includes('"content":"Hel"'));
  check('contains second delta', streamed.includes('"content":"lo"'));
  check('contains role chunk', streamed.includes('"role":"assistant"'));
  check('contains usage chunk', streamed.includes('"total_tokens":11'), streamed.slice(-300));
  check('finish_reason stop present', streamed.includes('"finish_reason":"stop"'));
  check('terminates with [DONE]', streamed.trim().endsWith('data: [DONE]'));

  // ------------------------------------------------------------ robustness
  section('Robustness');
  const empty = toAnthropicRequest({});
  check('empty body yields a valid message array', Array.isArray(empty.messages) && empty.messages.length === 1);
  const weird = fromAnthropicResponse(null);
  check('null response does not throw', weird.object === 'chat.completion' && Array.isArray(weird.choices));
  const garbage = await runStream([{ type: 'unknown_event' }]);
  check('unknown events are ignored', garbage === '' || !garbage.includes('undefined'));

  console.log('\n==================================================');
  console.log(`  PASSED: ${pass}    FAILED: ${fail}`);
  if (fail > 0) {
    console.log('\n  Failures:');
    for (const f of failures) console.log(`   - ${f}`);
  }
  console.log('==================================================\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
