// This runs on Netlify's servers as a BACKGROUND function (up to 15 minutes).
//
// 📝 HOTS test paper maker — writes the items that match the teacher's TOS (each item's number,
// competency and thinking level come from the TOS), with an answer key. The teacher reviews and
// edits before giving the test. Saves the result under the ticket for test-paper.mjs "status".

import { getStore } from '@netlify/blobs';
export const config = { background: true };

const FREE_AI_USES = 5;   // keep the same as free-ai.mjs
const monthKey = () => 'starter';

const TOOL = {
  name: 'test_paper',
  description: 'Return the test items.',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'object', properties: {
        n: { type: 'number' }, type: { type: 'string', enum: ['mc', 'open'] }, stem: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } }, answer: { type: 'string' }
      }, required: ['n', 'type', 'stem', 'answer'] } }
    },
    required: ['items']
  }
};

function buildPrompt(f, slots){
  const list = slots.map(s => `#${s.n} — ${s.level} — ${s.comp}`).join('\n');
  return `You write classroom test items for Filipino teachers (DepEd MATATAG). Subject: ${f.subject || 'not given'} · ${f.grade || 'level not given'} · ${f.title || 'test'}.
Write exactly these ${slots.length} items, one per line below, keeping each item's number, competency and thinking level (revised Bloom's taxonomy):
${list}

Rules:
- HOTS items (Analyzing, Evaluating, Creating) must start with a short, realistic situation, data, case, quote or problem — preferably from Filipino learners' daily life — then ask learners to analyze, judge or design. Never plain recall.
- Remembering/Understanding/Applying items are clear and fair, at the right level for ${f.grade || 'the learners'}.
- ${f.format === 'mc' ? 'All items are multiple choice ("type": "mc") with exactly 4 options.' : 'Use multiple choice ("type": "mc", exactly 4 options) for most items; for Evaluating and Creating items you may use "type": "open" (answer in a few sentences) — then "answer" lists what a full-credit answer must include.'}
- Multiple choice: one clearly best answer; wrong options come from common misconceptions; no "all/none of the above"; avoid negative stems. "answer" = the letter and the text, e.g. "B. Sunlight".
- Simple, clear English suitable for the level. Accurate content only.
${f.notes ? 'Teacher notes to cover: ' + f.notes : ''}
Fill in the test_paper tool.`;
}

export default async (req) => {
  const body = await req.json().catch(() => null) || {};
  const jobId = String(body.jobId || '');
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return;
  const jobs = getStore({ name: 'test-jobs', consistency: 'strong' });
  const results = getStore({ name: 'test-results', consistency: 'strong' });
  const job = await jobs.get(jobId, { type: 'json' });
  if (!job) return;
  await jobs.delete(jobId);
  const f = job.f, device = job.device;
  const store = getStore({ name: 'free-usage', consistency: 'strong' });
  const aiKey = 'ai:' + device + ':' + monthKey();

  // The slots come straight from the TOS: item number, thinking level, competency.
  const slots = [];
  f.plan.forEach(r => r.placed.forEach((nums, li) => nums.forEach(n => slots.push({ n, level: f.levels[li] || 'Understanding', comp: r.comp }))));
  slots.sort((a, b) => a.n - b.n);

  let reply;
  try {
    const used = Number(await store.get(aiKey)) || 0;
    if (used >= FREE_AI_USES) {
      reply = { error: "You've used your " + FREE_AI_USES + ' free AI uses. Thank you for trying the app!', used, limit: FREE_AI_USES, left: 0 };
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 14000, system: buildPrompt(f, slots),
          tools: [TOOL], tool_choice: { type: 'tool', name: 'test_paper' },
          messages: [{ role: 'user', content: 'Write the test now.' }] })
      });
      const data = await res.json().catch(() => ({}));
      const out = res.ok && (data.content || []).find(b => b.type === 'tool_use');
      const got = out && out.input && Array.isArray(out.input.items) ? out.input.items : [];
      if (!got.length) {
        console.log('test-paper: AI error', res.status, JSON.stringify(data).slice(0, 300));
        reply = { error: res.ok ? 'Received an unexpected response. Please try again.' : 'Could not reach the test service (' + res.status + '). Please try again.' };
      } else {
        const byN = new Map(got.map(it => [Number(it.n), it]));
        const items = slots.map(s => {
          const it = byN.get(s.n); if (!it) return null;
          const mc = it.type !== 'open' && Array.isArray(it.options) && it.options.length >= 2;
          return { n: s.n, comp: s.comp, level: s.level, type: mc ? 'mc' : 'open', stem: String(it.stem || ''), options: mc ? it.options.slice(0, 4).map(String) : [], answer: String(it.answer || '') };
        }).filter(Boolean);
        const now = (Number(await store.get(aiKey)) || 0) + 1;
        await store.set(aiKey, String(now));
        reply = { items, used: now, limit: FREE_AI_USES, left: Math.max(0, FREE_AI_USES - now) };
      }
    }
  } catch (e) {
    reply = { error: 'Could not make the test right now. Please try again.' };
  }
  await results.setJSON(jobId, { done: true, at: Date.now(), ...reply });
};
