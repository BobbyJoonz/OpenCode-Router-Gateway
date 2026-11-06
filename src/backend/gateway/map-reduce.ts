/**
 * Map-reduce for prompts larger than a model's context window.
 *
 * A gateway cannot make a model accept 300k tokens if its window is 128k. What it
 * *can* do is split the oversized input, extract the facts that matter for the
 * actual question, and answer from those notes.
 *
 * Design notes:
 * - The map phase is always non-streaming (summaries are internal).
 * - The reduce call is returned as a body, so the caller can stream it through the
 *   normal path — the client sees tokens as soon as the reduce starts.
 * - It is lossy by nature, so it is opt-in and every response carries
 *   `x-opencode-mapreduce` + `x-opencode-chunks`.
 */
export interface MapReduceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface MapPhaseResult {
  /** Ready-to-forward body for the final call (stream flag preserved). */
  reduceBody: any;
  usage: MapReduceUsage;
  chunks: number;
  mapCalls: number;
}

export interface MapReduceResult extends MapPhaseResult {
  final: any;
}

export interface MapReduceOptions {
  body: any;
  /** Estimated prompt tokens above which splitting kicks in. */
  contextLimit: number;
  /** Target tokens per chunk. */
  chunkTokens: number;
  maxChunks: number;
  /** Optional extra instruction appended to every map prompt. */
  mapInstruction?: string;
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

/**
 * The question the maps should optimise for: the last non-oversized user turn if
 * there is one, otherwise the tail of the oversized message (people usually put
 * their question at the end).
 */
function findQuestion(messages: any[], target: { index: number; content: string }): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (i === target.index) continue;
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    const text = message.content.trim();
    if (text) return text.slice(0, 600);
  }
  return target.content.trim().slice(-600);
}

export function shouldMapReduce(body: any, contextLimit: number, estimatedTokens: number): boolean {
  if (!contextLimit || contextLimit <= 0) return false;
  if (!Array.isArray(body?.messages)) return false;
  if (estimatedTokens <= contextLimit) return false;
  return findLargestUserMessage(body.messages) !== null;
}

export function buildReduceBody(
  body: any,
  targetIndex: number,
  summaries: string[],
  question: string
): any {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const reduceMessages = messages.map((message: any, index: number) => {
    if (index !== targetIndex) return message;
    const notes = summaries.map((summary, i) => `[Part ${i + 1}]\n${summary}`).join('\n\n');
    return {
      role: 'user',
      content:
        `The original input was too large for the model's context window, so it was split into ` +
        `${summaries.length} parts and each part was summarised. Those notes are below.\n\n` +
        `QUESTION:\n${question}\n\nCOMPILED NOTES:\n${notes}\n\n` +
        `Answer the QUESTION using the notes. If the notes do not contain the answer, say so plainly.`
    };
  });
  // Preserve the caller's stream flag: the reduce call can be streamed normally.
  return { ...body, messages: reduceMessages };
}

/**
 * Runs the map phase and returns a body ready for the final (possibly streaming)
 * call. Throws MAPREDUCE_NOT_APPLICABLE / MAPREDUCE_TOO_LARGE on bad input.
 */
export async function runMapPhase(opts: MapReduceOptions): Promise<MapPhaseResult> {
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

  const question = findQuestion(messages, target);
  const budget = Math.max(200, Math.min(800, Math.round(opts.chunkTokens / 40)));
  const extra = opts.mapInstruction ? `\n${opts.mapInstruction}` : '';

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
            `You are extracting facts from part ${i + 1} of ${totalChunks} of a long document.\n` +
            `The final question that must be answered is:\n${question}\n\n` +
            `Extract ONLY facts, numbers, names, dates and constraints that could help answer ` +
            `that question. Use at most ${budget} words. No commentary, no preamble.${extra}\n\n` +
            `---\n${chunk}\n---`
        }
      ],
      max_tokens: Math.min(1200, budget * 2),
      temperature: 0
    };

    const response = await opts.forwardJson(mapBody);
    mapCalls++;
    sumUsage(usage, response?.usage);
    summaries.push(extractText(response));
  }

  return {
    reduceBody: buildReduceBody(opts.body, target.index, summaries, question),
    usage,
    chunks: totalChunks,
    mapCalls
  };
}

/**
 * Convenience wrapper for callers that want the whole answer in one object
 * (tests, non-streaming use).
 */
export async function mapReduce(opts: MapReduceOptions): Promise<MapReduceResult> {
  const phase = await runMapPhase(opts);
  const final = await opts.forwardJson(phase.reduceBody);
  sumUsage(phase.usage, final?.usage);
  return { ...phase, final };
}
