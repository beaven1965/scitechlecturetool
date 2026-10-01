// This runs on Netlify's servers, not in the visitor's browser.
//
// 📝 ILAW Lesson Plan helper — ticket desk.
//   { action: 'start', device, subject, topic, level, duration, minutes, code, learners, ideas, indicators }
//        -> checks the free AI uses, saves the request, returns { jobId }
//   { action: 'status', jobId } -> { pending: true } while writing, then { plan, used, limit, left } or { error }
// The plan itself is written by ilaw-plan-work-background.mjs (allowed up to 15 minutes).

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const FREE_AI_USES = 5;   // keep the same as free-ai.mjs and ilaw-plan-work-background.mjs
const monthKey = () => 'starter';   // one-time free load per device — no monthly reset
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null) || {};
  const jobs = getStore({ name: 'ilaw-jobs', consistency: 'strong' });
  const results = getStore({ name: 'ilaw-results', consistency: 'strong' });

  if (body.action === 'status') {
    const jobId = String(body.jobId || '');
    if (!/^[0-9a-f-]{36}$/.test(jobId)) return json({ error: 'Unknown ticket.' });
    const r = await results.get(jobId, { type: 'json' });
    if (r) { await results.delete(jobId); return json(r); }
    return json({ pending: true });
  }

  if (body.action === 'start') {
    if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'Server is not configured with an Anthropic API key yet.' });
    const device = String(body.device || '');
    if (!validDevice(device)) return json({ error: 'Please refresh the app and try again.' });
    const f = {
      subject: clean(body.subject, 120), level: clean(body.level, 60), duration: clean(body.duration, 40),
      minutes: Math.max(10, Math.min(480, parseInt(body.minutes, 10) || 60)),
      topic: clean(body.topic, 300), code: clean(body.code, 60), learners: clean(body.learners, 400), ideas: clean(body.ideas, 800),
      indicators: (Array.isArray(body.indicators) ? body.indicators : []).map(String).slice(0, 20)
    };
    if (!f.subject || !f.topic) return json({ error: 'Please enter both a subject and a topic.' });
    const used = Number(await getStore({ name: 'free-usage', consistency: 'strong' }).get('ai:' + device + ':' + monthKey())) || 0;
    if (used >= FREE_AI_USES) return json({ error: "You've used your " + FREE_AI_USES + ' free AI uses. Thank you for trying the app!', used, limit: FREE_AI_USES, left: 0 });
    const jobId = crypto.randomUUID();
    await jobs.setJSON(jobId, { device, f, at: Date.now() });
    return json({ jobId });
  }

  return json({ error: 'Unknown request.' });
};
