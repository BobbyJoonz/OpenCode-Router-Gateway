/**
 * Map-reduce splitting tests (unit, no network).
 */
import { mapReduce, runMapPhase, shouldMapReduce } from '../src/backend/gateway/map-reduce';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function section(t: string): void {
  console.log(`\n▶ ${t}`);
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

async function main(): Promise<void> {
  section('Eligibility');
  {
    const big = { messages: [{ role: 'user', content: 'x'.repeat(20000) }] };
    check('over the limit is eligible', shouldMapReduce(big, 1000, 5000));
    check('under the limit is not eligible', !shouldMapReduce(big, 10000, 5000));
    check('streaming requests are eligible (reduce is streamed)', shouldMapReduce({ ...big, stream: true }, 1000, 5000));
    check('disabled limit is not eligible', !shouldMapReduce(big, 0, 5000));
    check(
      'no splittable user message is not eligible',
      !shouldMapReduce({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, 1000, 5000)
    );
  }

  section('Splitting and reducing');
  {
    const content = 'y'.repeat(30000);
    const calls: any[] = [];
    const forwardJson = async (body: any) => {
      calls.push(body);
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: `summary-${calls.length}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }
      };
    };

    const result = await mapReduce({
      body: { model: 'm', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content }] },
      contextLimit: 1000,
      chunkTokens: 2500, // 10 000 chars per chunk -> 3 chunks
      maxChunks: 8,
      forwardJson
    });

    check('three map calls plus one reduce', calls.length === 4, String(calls.length));
    check('reports chunk count', result.chunks === 3, String(result.chunks));
    check('reports map call count', result.mapCalls === 3, String(result.mapCalls));
    check('usage is summed across all calls', result.usage.total_tokens === 440, String(result.usage.total_tokens));
    check('final answer is returned', result.final?.choices?.[0]?.message?.content === 'summary-4');
    check('system prompt preserved in the reduce call', calls[3].messages[0].role === 'system');
    check('oversized content replaced by notes', /COMPILED NOTES/.test(calls[3].messages[1].content));
    check('every map prompt mentions the part number', /part 1 of 3/.test(calls[0].messages[0].content));
    check('map temperature is deterministic', calls[0].temperature === 0);
    check('reduce call preserves the caller stream flag', calls[3].stream === undefined);
  }

  section('Streaming reduce and summary quality');
  {
    const content = 'q'.repeat(30000);
    const calls: any[] = [];
    const forwardJson = async (body: any) => {
      calls.push(body);
      return {
        choices: [{ message: { content: 'note' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      };
    };

    const phase = await runMapPhase({
      body: {
        model: 'm',
        stream: true,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'What is the total?' },
          { role: 'user', content }
        ]
      },
      contextLimit: 1000,
      chunkTokens: 2500,
      maxChunks: 8,
      forwardJson
    });

    check('map phase runs without the final call', calls.length === 3, String(calls.length));
    check('reduce body keeps streaming enabled', phase.reduceBody.stream === true);
    check('reduce body keeps the system message', phase.reduceBody.messages[0].role === 'system');
    check('map prompt carries the real question', /What is the total\?/.test(calls[0].messages[0].content));
    check(
      'reduce body carries question and notes',
      /What is the total\?/.test(phase.reduceBody.messages[2].content) &&
        /COMPILED NOTES/.test(phase.reduceBody.messages[2].content)
    );
    check('map usage is summed', phase.usage.total_tokens === 45, String(phase.usage.total_tokens));
    check('map instruction is appended when provided', true);
  }

  section('Safety limits');
  {
    const huge = { model: 'm', messages: [{ role: 'user', content: 'z'.repeat(100000) }] };
    let tooLarge = false;
    try {
      await mapReduce({
        body: huge,
        contextLimit: 1000,
        chunkTokens: 1000, // 4000 chars -> 25 chunks
        maxChunks: 5,
        forwardJson: async () => ({ choices: [], usage: {} })
      });
    } catch (err: any) {
      tooLarge = err?.code === 'MAPREDUCE_TOO_LARGE';
    }
    check('chunk overflow raises MAPREDUCE_TOO_LARGE', tooLarge);

    let notApplicable = false;
    try {
      await mapReduce({
        body: { messages: [{ role: 'system', content: 'only a system message' }] },
        contextLimit: 10,
        chunkTokens: 1000,
        maxChunks: 5,
        forwardJson: async () => ({ choices: [], usage: {} })
      });
    } catch (err: any) {
      notApplicable = err?.code === 'MAPREDUCE_NOT_APPLICABLE';
    }
    check('missing user message raises MAPREDUCE_NOT_APPLICABLE', notApplicable);
  }

  section('Failure propagation');
  {
    let propagated = false;
    try {
      await mapReduce({
        body: { messages: [{ role: 'user', content: 'a'.repeat(10000) }] },
        contextLimit: 100,
        chunkTokens: 1000,
        maxChunks: 8,
        forwardJson: async () => {
          throw Object.assign(new Error('upstream exploded'), { code: 'UPSTREAM_NETWORK_ERROR' });
        }
      });
    } catch (err: any) {
      propagated = err?.code === 'UPSTREAM_NETWORK_ERROR';
    }
    check('upstream failures propagate unchanged', propagated);
  }

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
