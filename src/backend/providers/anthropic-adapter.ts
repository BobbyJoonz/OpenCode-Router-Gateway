import { Transform } from 'stream';

/**
 * Anthropic <-> OpenAI translation.
 *
 * The gateway exposes an OpenAI-shaped surface. When a provider's `kind` is
 * `anthropic`, both directions must be translated:
 *
 *   request:  OpenAI chat.completions  ->  Anthropic /v1/messages
 *   response: Anthropic JSON or SSE    ->  OpenAI chat.completion / chat.completion.chunk
 *
 * Only the parts that matter for chat are covered: system prompt, text and image
 * content, tools/tool_choice, stop, temperature/top_p, streaming and usage.
 */

const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

function toAnthropicContent(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');

  const parts: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const url: string = part.image_url.url;
      const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(url);
      if (match) {
        parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
      } else {
        parts.push({ type: 'image', source: { type: 'url', url } });
      }
    }
  }
  return parts.length > 0 ? parts : '';
}

export function toAnthropicRequest(openaiBody: any): any {
  const body = openaiBody && typeof openaiBody === 'object' ? openaiBody : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const systemParts: string[] = [];
  const converted: any[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;

    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
          }
        ]
      });
      continue;
    }

    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const content: any[] = [];
      if (typeof message.content === 'string' && message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) {
        let input: any = {};
        try {
          input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name || 'tool', input });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }

    if (role === 'user' || role === 'assistant') {
      converted.push({ role, content: toAnthropicContent(message.content) });
    }
  }

  // Anthropic requires at least one user message and alternating roles; merge
  // consecutive same-role messages, which the API tolerates.
  const merged: any[] = [];
  for (const message of converted) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      const lastContent = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
      const nextContent = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }];
      last.content = [...lastContent, ...nextContent];
    } else {
      merged.push({ ...message });
    }
  }

  const out: any = {
    model: body.model,
    max_tokens: Number(body.max_completion_tokens ?? body.max_tokens ?? 1024) || 1024,
    messages: merged.length > 0 ? merged : [{ role: 'user', content: '' }],
    stream: body.stream === true
  };

  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((tool: any) => tool?.type === 'function' && tool.function)
      .map((tool: any) => ({
        name: tool.function.name,
        description: tool.function.description || undefined,
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      }));
  }

  if (body.tool_choice !== undefined) {
    if (body.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') out.tool_choice = { type: 'any' };
    else if (body.tool_choice === 'none') out.tool_choice = undefined;
    else if (body.tool_choice?.function?.name) out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
  }

  return out;
}

function mapStopReason(reason: string | undefined): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ? 'stop' : null;
  }
}

export function fromAnthropicResponse(anthropic: any): any {
  const content = Array.isArray(anthropic?.content) ? anthropic.content : [];
  const text = content
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('');
  const toolUses = content.filter((block: any) => block?.type === 'tool_use');

  const message: any = { role: 'assistant', content: text || null };
  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map((block: any) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
    }));
  }

  const usage = anthropic?.usage || {};
  return {
    id: anthropic?.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropic?.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(anthropic?.stop_reason)
      }
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens) || 0,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0)
    }
  };
}

/** Buffers a complete Anthropic JSON response and emits the OpenAI equivalent. */
export function anthropicJsonToOpenAi(): Transform {
  const chunks: Buffer[] = [];
  return new Transform({
    transform(chunk, _enc, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
    flush(callback) {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        this.push(Buffer.from(JSON.stringify(fromAnthropicResponse(parsed)), 'utf8'));
      } catch (err: any) {
        this.destroy(err);
        return;
      }
      callback();
    }
  });
}

/**
 * Converts Anthropic SSE into OpenAI `chat.completion.chunk` events.
 *
 * Anthropic emits: message_start, content_block_start, content_block_delta,
 * content_block_stop, message_delta, message_stop.
 */
export function anthropicSseToOpenAi(): Transform {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let model: string | undefined;
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason: string | null = null;
  let roleSent = false;

  const emit = (obj: any) => {
    push(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const push = (text: string) => {
    transform.push(Buffer.from(text, 'utf8'));
  };
  const chunk = (delta: any, finish: string | null = null, usage?: any) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: model || undefined,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {})
  });

  let transform: Transform;

  const handleEvent = (event: string, data: any) => {
    switch (event) {
      case 'message_start': {
        model = data?.message?.model;
        promptTokens = Number(data?.message?.usage?.input_tokens) || promptTokens;
        if (!roleSent) {
          roleSent = true;
          emit(chunk({ role: 'assistant', content: '' }));
        }
        break;
      }
      case 'content_block_start': {
        if (data?.content_block?.type === 'text' && data.content_block.text) {
          emit(chunk({ content: data.content_block.text }));
        }
        break;
      }
      case 'content_block_delta': {
        const delta = data?.delta;
        if (delta?.type === 'text_delta' && delta.text) {
          emit(chunk({ content: delta.text }));
        }
        break;
      }
      case 'message_delta': {
        finishReason = mapStopReason(data?.delta?.stop_reason) || finishReason;
        completionTokens = Number(data?.usage?.output_tokens) || completionTokens;
        break;
      }
      case 'message_stop': {
        emit(
          chunk({}, finishReason || 'stop', {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          })
        );
        push('data: [DONE]\n\n');
        break;
      }
      default:
        break;
    }
  };

  transform = new Transform({
    transform(input, _enc, callback) {
      buffer += Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = '';
        let dataLine = '';
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (dataLine) {
          try {
            handleEvent(eventName, JSON.parse(dataLine));
          } catch {
            /* partial or non-JSON keep-alive */
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
      callback();
    },
    flush(callback) {
      callback();
    }
  });

  return transform;
}

export function anthropicModelsList(): string {
  return JSON.stringify({
    object: 'list',
    data: [{ id: 'anthropic', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' }]
  });
}

export { ANTHROPIC_VERSION };
