/**
 * Upstream contract tests.
 *
 * Two modes:
 *   fixture  (default) — validates the OpenAI-compatible schemas we rely on
 *                        against recorded fixtures. Runs everywhere, no network.
 *   live     — hits a real provider when CONTRACT_BASE_URL / CONTRACT_API_KEY /
 *              CONTRACT_MODEL are set. This is the only mode that can catch an
 *              upstream API change; run it in the nightly workflow.
 *
 * Exit code 0 = pass or skipped, 1 = contract violated.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type Json = any;

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

function isObject(v: Json): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateModels(json: Json): string[] {
  const errors: string[] = [];
  if (!isObject(json)) return ['response is not an object'];
  if (json.object !== 'list') errors.push(`object must be "list", got ${JSON.stringify(json.object)}`);
  if (!Array.isArray(json.data)) return [...errors, 'data must be an array'];
  for (const model of json.data) {
    if (!isObject(model)) {
      errors.push('data item is not an object');
      continue;
    }
    if (typeof model.id !== 'string' || model.id.length === 0) errors.push('model.id must be a non-empty string');
    if (model.object !== 'model') errors.push(`model.object must be "model", got ${JSON.stringify(model.object)}`);
  }
  return errors;
}

function validateCompletion(json: Json): string[] {
  const errors: string[] = [];
  if (!isObject(json)) return ['response is not an object'];
  if (json.object !== 'chat.completion') errors.push(`object must be "chat.completion", got ${JSON.stringify(json.object)}`);
  if (!Array.isArray(json.choices) || json.choices.length === 0) return [...errors, 'choices must be a non-empty array'];
  const choice = json.choices[0];
  if (choice.index !== 0) errors.push('choices[0].index must be 0');
  if (!isObject(choice.message)) errors.push('choices[0].message must be an object');
  else {
    if (choice.message.role !== 'assistant') errors.push('message.role must be "assistant"');
    if (typeof choice.message.content !== 'string') errors.push('message.content must be a string');
  }
  if (typeof choice.finish_reason !== 'string') errors.push('finish_reason must be a string');
  if (json.usage) {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (!Number.isInteger(json.usage[key]) || json.usage[key] < 0) errors.push(`usage.${key} must be a non-negative integer`);
    }
  }
  return errors;
}

function validateStream(text: string): string[] {
  const errors: string[] = [];
  if (!text.includes('data:')) errors.push('stream has no "data:" frames');
  if (!text.includes('[DONE]')) errors.push('stream has no [DONE] terminator');

  const frames = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((d) => d && d !== '[DONE]');

  if (frames.length === 0) errors.push('stream has no JSON frames');

  let sawDelta = false;
  let sawUsage = false;
  for (const frame of frames) {
    let parsed: Json;
    try {
      parsed = JSON.parse(frame);
    } catch {
      errors.push(`unparsable frame: ${frame.slice(0, 60)}`);
      continue;
    }
    if (parsed.object === 'chat.completion.chunk') sawDelta = true;
    if (parsed.usage && Number.isInteger(parsed.usage.total_tokens)) sawUsage = true;
  }
  if (!sawDelta) errors.push('no chat.completion.chunk frame');
  if (!sawUsage) errors.push('no usage frame (stream_options.include_usage may be unsupported)');
  return errors;
}

function validateErrorEnvelope(json: Json): string[] {
  if (!isObject(json) || !isObject(json.error)) return ['error envelope must be { error: { ... } }'];
  const errors: string[] = [];
  if (typeof json.error.message !== 'string') errors.push('error.message must be a string');
  if (typeof json.error.type !== 'string') errors.push('error.type must be a string');
  return errors;
}

async function fixtureMode(): Promise<void> {
  console.log('mode: fixture (no network)');
  const dir = path.join(__dirname, 'fixtures');

  const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf-8'));
  check('fixture /models matches OpenAI list schema', validateModels(models).length === 0, validateModels(models).join('; '));

  const completion = JSON.parse(fs.readFileSync(path.join(dir, 'completion.json'), 'utf-8'));
  const completionErrors = validateCompletion(completion);
  check('fixture /chat/completions matches OpenAI schema', completionErrors.length === 0, completionErrors.join('; '));

  const streamFixture = [
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ delta: { content: 'hi' } }] })}`,
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
    'data: [DONE]',
    ''
  ].join('\n\n');
  const streamErrors = validateStream(streamFixture);
  check('fixture SSE stream matches expectations', streamErrors.length === 0, streamErrors.join('; '));

  check(
    'error envelope validator accepts a valid envelope',
    validateErrorEnvelope({ error: { message: 'bad', type: 'invalid_request_error', code: 'x' } }).length === 0
  );

  // Negative controls: the validators must actually reject bad shapes.
  check('validator rejects a non-list /models payload', validateModels({ object: 'nope' }).length > 0);
  check('validator rejects a completion without choices', validateCompletion({ object: 'chat.completion', choices: [] }).length > 0);
  check('validator rejects a stream without [DONE]', validateStream('data: {}\n\n').length > 0);
  check('validator rejects a malformed error envelope', validateErrorEnvelope({ message: 'x' }).length > 0);
}

async function liveMode(baseUrl: string, apiKey: string, model: string): Promise<void> {
  console.log(`mode: live -> ${baseUrl}`);

  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };

  const modelsRes = await fetch(`${baseUrl}/models`, { headers });
  check('/models returns 200', modelsRes.status === 200, `status ${modelsRes.status}`);
  if (modelsRes.status === 200) {
    const errors = validateModels(await modelsRes.json());
    check('/models matches OpenAI schema', errors.length === 0, errors.join('; '));
  }

  const completionRes = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: CONTRACT_OK' }] })
  });
  check('non-streaming completion returns 200', completionRes.status === 200, `status ${completionRes.status}`);
  if (completionRes.status === 200) {
    const errors = validateCompletion(await completionRes.json());
    check('non-streaming completion matches schema', errors.length === 0, errors.join('; '));
  }

  const streamRes = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Reply with exactly: STREAM_OK' }]
    })
  });
  check('streaming completion returns 200', streamRes.status === 200, `status ${streamRes.status}`);
  if (streamRes.status === 200) {
    const errors = validateStream(await streamRes.text());
    check('SSE stream matches expectations', errors.length === 0, errors.join('; '));
  }

  const badKeyRes = await fetch(`${baseUrl}/models`, { headers: { authorization: 'Bearer definitely-wrong' } });
  check('bad credentials are rejected', badKeyRes.status === 401 || badKeyRes.status === 403, `status ${badKeyRes.status}`);
  if (badKeyRes.status === 401) {
    const text = await badKeyRes.text();
    try {
      check('401 body is an OpenAI error envelope', validateErrorEnvelope(JSON.parse(text)).length === 0);
    } catch {
      check('401 body is an OpenAI error envelope', false, 'body is not JSON');
    }
  }
}

async function main(): Promise<void> {
  const baseUrl = (process.env.CONTRACT_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.CONTRACT_API_KEY || '';
  const model = process.env.CONTRACT_MODEL || 'gpt-4o-mini';

  console.log('▶ Upstream contract tests');
  if (baseUrl && apiKey) {
    await liveMode(baseUrl, apiKey, model);
  } else {
    console.log('  ℹ CONTRACT_BASE_URL / CONTRACT_API_KEY not set — running fixture mode only.');
    console.log('    Set them (and CONTRACT_MODEL) to validate a real provider.');
    await fixtureMode();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✘ ${f.name}: ${f.detail || ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('contract test crashed:', err);
  process.exit(1);
});
