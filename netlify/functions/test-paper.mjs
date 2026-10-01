// This runs on Netlify's servers, not in the visitor's browser.
//
// 📝 HOTS test paper maker — ticket desk.
//   { action: 'start', device, subject, grade, title, format, notes, total, levels, plan }  -> { jobId }
//   { action: 'status', jobId } -> { pending: true } while writing, then { items, used, limit, left } or { error }
// The test itself is written by test-paper-work-background.mjs (allowed up to 15 minutes).
// One test = 1 of the device's free AI uses (counted only when the test is delivered).

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const FREE_AI_USES = 5;   // keep the same as free-ai.mjs
const monthKey = () => 'starter';
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null) || {};
  const jobs = getStore({ name: 'test-jobs', consistency: 'strong' });
  const results = getStore({ name: 'test-results', consistency: 'strong' });

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
    const levels = (Array.isArray(body.levels) ? body.levels : []).map(l => clean(l, 20)).slice(0, 6);
    const plan = (Array.isArray(body.plan) ? body.plan : []).slice(0, 15).map(r => ({
      comp: clean(r.comp, 200),
      placed: (Array.isArray(r.placed) ? r.placed : []).slice(0, 6).map(a => (Array.isArray(a) ? a : []).map(n => parseInt(n, 10)).filter(n => n > 0 && n <= 60))
    })).filter(r => r.comp);
    const count = plan.reduce((a, r) => a + r.placed.reduce((b, x) => b + x.length, 0), 0);
    if (!plan.length || !count) return json({ error: 'Please make your TOS first.' });
    if (count > 60) return json({ error: 'The test maker can write up to 60 items at a time.' });
    const used = Number(await getStore({ name: 'free-usage', consistency: 'strong' }).get('ai:' + device + ':' + monthKey())) || 0;
    if (used >= FREE_AI_USES) return json({ error: "You've used your " + FREE_AI_USES + ' free AI uses. Thank you for trying the app!', used, limit: FREE_AI_USES, left: 0 });
    const f = { subject: clean(body.subject, 80), grade: clean(body.grade, 40), title: clean(body.title, 120),
      format: body.format === 'mc' ? 'mc' : 'mixed', notes: clean(body.notes, 800), levels, plan, count };
    const jobId = crypto.randomUUID();
    await jobs.setJSON(jobId, { device, f, at: Date.now() });
    return json({ jobId });
  }

  return json({ error: 'Unknown request.' });
};
