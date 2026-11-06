/**
 * Map-reduce for prompts larger than a model's context window.
 *
 * A gateway cannot make a model accept 300k tokens if its window is 128k. What it
 * *can* do is split the oversized input, summarise each part, and answer from the
 * summaries. That changes semantics (it is a lossy pipeline), so it is opt-in and
 * never used for streaming requests.
 *
 * The caller supplies `forwardJson`, which performs one non-streaming upstream
 * call through the normal provider/egress path; this module only orchestrates.
 */
export interface MapReduceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface MapReduceResult {
  final: any;
  usage: MapReduceUsage;
  chunks: number;
  mapCalls: number;
}

export interface MapReduceOptions {
  body: any;
  /** Estimated prompt tokens above which splitting kicks in. */
  contextLimit: number;
  /** Target tokens per chunk. */
  chunkTokens: number;
  maxChunks: number;
  forwardJson: (body: any) => Promise<any>;
}

const CHARS_PER_TOKEN = 4;

function sumUsage(into: MapReduceUsage, usage: any): void {
  if (!usage || typeof usage !== 'object') return;
  into.prompt_tokens += Number(usage.prompt_tokens) || 0;
  into.completion_tokens += Number(usage.completion_tokens) || 0;
  into.total_tokens += Number(usage.total_tokens) || 0;
}

function extractText(response: any): string {
  const choice = response?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

/**
 * Finds the largest user message with string content — that is the one that
 * pushed the request over the window.
 */
function findLargestUserMessage(messages: any[]): { index: number; content: string } | null {
  let best: { index: number; content: string } | null = null;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content !== 'string') continue;
    if (!best || message.content.length > best.content.length) {
      best = { index: i, content: message.content };
    }
  }
  return best;
}

export function shouldMapReduce(body: any, contextLimit: number, estimatedTokens: number): boolean {
  if (!contextLimit || contextLimit <= 0) return false;
  if (body?.stream === true) return false;
  if (!Array.isArray(body?.messages)) return false;
  if (estimatedTokens <= contextLimit) return false;
  return findLargestUserMessage(body.messages) !== null;
}

export async function mapReduce(opts: MapReduceOptions): Promise<MapReduceResult> {
  const messages = Array.isArray(opts.body?.messages) ? opts.body.messages : [];
  const target = findLargestUserMessage(messages);
  if (!target) {
    throw Object.assign(new Error('map-reduce requested but no splittable user message was found'), {
      code: 'MAPREDUCE_NOT_APPLICABLE'
    });
  }

  const chunkChars = Math.max(2000, opts.chunkTokens * CHARS_PER_TOKEN);
  const totalChunks = Math.ceil(target.content.length / chunkChars);
  if (totalChunks > opts.maxChunks) {
    throw Object.assign(
      new Error(`Input needs ${totalChunks} chunks but the limit is ${opts.maxChunks}`),
      { code: 'MAPREDUCE_TOO_LARGE', chunks: totalChunks }
    );
  }

  const usage: MapReduceUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const summaries: string[] = [];
  let mapCalls = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = target.content.slice(i * chunkChars, (i + 1) * chunkChars);
    const mapBody = {
      model: opts.body.model,
      messages: [
        {
          role: 'user',
          content:
            `You are summarising part ${i + 1} of ${totalChunks} of a long document. ` +
            `Extract every fact that could matter for answering the question at the end, ` +
            `in at most 400 words. Do not add commentary.\n\n---\n${chunk}\n---`
        }
      ],
      max_tokens: Math.min(800, Number(opts.body.max_tokens) || 800),
      temperature: 0
    };

    const response = await opts.forwardJson(mapBody);
    mapCalls++;
    sumUsage(usage, response?.usage);
    summaries.push(extractText(response));
  }

  // Reduce: keep the original conversation but replace the oversized message with
  // the compiled notes, so the model still sees the instructions and any earlier
  // turns.
  const reduceMessages = messages.map((message: any, index: number) => {
    if (index !== target.index) return message;
    return {
      role: 'user',
      content:
        `The original input was too large for the context window and has been split into ` +
        `${totalChunks} parts. Here are the compiled notes:\n\n${summaries
          .map((s, i) => `[Part ${i + 1}]\n${s}`)
          .join('\n\n')}\n\n` +
        `Original request (repeated):\n${target.content.slice(-2000)}`
    };
  });

  const finalBody = { ...opts.body, messages: reduceMessages, stream: false };
  const final = await opts.forwardJson(finalBody);
  sumUsage(usage, final?.usage);

  return { final, usage, chunks: totalChunks, mapCalls };
}
