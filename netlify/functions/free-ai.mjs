// This runs on Netlify's servers, not in the visitor's browser.
//
// Free load helper for ScitechLectureTool (no codes needed while Premium is hidden).
// Every phone/laptop gets a one-time free load (no monthly reset):
//   • 60 recording minutes (counted in transcribe.js)
//   • 5 AI uses — lesson plans, quizzes and highlight translations (counted here and in ilaw-plan.mjs)
//   { action: 'status', device }                      -> { minutesUsed, minutesLimit, minutesLeft, used, limit, left }
//   { action: 'reserve', device, kind: 'quiz' }        -> { token, ...status }   (one quiz = one use, any number of parts)
//   { action: 'translate', device, bullets, language } -> { bullets, ...status }
// Needs ANTHROPIC_API_KEY as a Netlify environment variable.

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

const FREE_MINUTES = 60;   // keep the same as transcribe.js
const FREE_AI_USES = 5;    // keep the same as ilaw-plan.mjs
const phNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString();
const monthKey = () => 'starter';   // one-time free load per device — no monthly reset
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function statusOf(store, device){
  const minUsed = Number(await store.get('min:' + device + ':' + monthKey())) || 0;
  const used = Number(await store.get('ai:' + device + ':' + monthKey())) || 0;
  return {
    minutesUsed: Math.ceil(minUsed / 60), minutesLimit: FREE_MINUTES, minutesLeft: Math.max(0, Math.floor((FREE_MINUTES * 60 - minUsed) / 60)),
    used, limit: FREE_AI_USES, left: Math.max(0, FREE_AI_USES - used)
  };
}
const NONE_LEFT = "You've used your " + FREE_AI_USES + ' free AI uses. Thank you for trying the app!';

const regionalExemplars = {
  'cebuano (bisaya)': `Worked examples of genuine Cebuano (Bisaya) — study the vocabulary and sentence patterns, they are NOT Tagalog:
- "She denied any connection between the two investigations." → "Gilalis niya ang bisan unsang koneksyon tali sa duha ka imbestigasyon."
- "He said his office works independently of his wife's role." → "Miingon siya nga ang iyang opisina naglihok nga independente sa tahas sa iyang asawa."
- "She promised full cooperation with local investigations." → "Misaad siya og bug-os nga kooperasyon sa lokal nga mga imbestigasyon."
- "This is the day the Lord has made." → "Kini ang adlaw nga gibuhat sa Ginoo."
Notice: "tali sa" (between/among) not "sa pagitan ng"; "og"/"ug" (and) not "at"; "niya/siya" placement and verb-first sentence order; "mga" for plurals like Tagalog but very different verbs and connectors ("nga" not "na/ng" in most places).`,
  'ilocano': `Worked examples of genuine Ilocano — study the vocabulary and sentence patterns, they are NOT Tagalog:
- "She denied any connection between the two investigations." → "Inlibakna ti aniaman a koneksion iti nagbaetan ti dua nga imbestigasion."
- "He said his office works independently of his wife's role." → "Kinunana a ti opisinana ket agtrabaho a sibubukel manipud iti akem ti asawana."
- "She promised full cooperation with local investigations." → "Nangipatulod isuna iti naan-anay a kooperasion kadagiti lokal nga imbestigasion."
- "This is the day the Lord has made." → "Daytoy ti aldaw nga inaramid ti Apo."
Notice: "iti nagbaetan" (between/among) not "sa pagitan ng"; "ken" (and) not "at"; "ti/iti" articles instead of "ang/ng/sa"; "kinunana", "nangipatulod" verb forms instead of Tagalog "sinabi niya", "nangako siya".`
};

async function translateBullets(bullets, language){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'Server is not configured with an Anthropic API key yet.' };
  const langKey = language.trim().toLowerCase();
  const exemplarBlock = regionalExemplars[langKey] ? '\n\n' + regionalExemplars[langKey] : '';
  const system = `You translate the highlight bullet points of a lecture or talk into ${language}.
Translate naturally and faithfully — the real meaning and tone, warm and easy to read aloud, the way a fluent native speaker would say it. Keep names of people, places and Bible books in their usual form for ${language}.
If ${language} is a regional Philippine language (Cebuano, Ilocano, Hiligaynon, Bikol, Waray, Kapampangan, Pangasinan), write in that language's own vocabulary and grammar — NOT Tagalog with a few words swapped.${exemplarBlock}
Reply with ONLY this JSON and nothing else: {"bullets": ["...", "..."]} — the same number of bullets, in the same order.`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 50000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: abort.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2000, system,
        messages: [{ role: 'user', content: bullets.map(b => '- ' + b).join('\n') }] })
    });
    clearTimeout(timer);
    if (!res.ok) return { error: 'Translation failed (' + res.status + '). Please try again.' };
    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('');
    let parsed = null;
    try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (e) {}
    const out = parsed && Array.isArray(parsed.bullets) ? parsed.bullets.map(b => String(b || '').trim()).filter(Boolean) : [];
    if (!out.length) return { error: 'Received an unexpected response. Please try again.' };
    return { bullets: out };
  } catch (e) {
    clearTimeout(timer);
    return { error: abort.signal.aborted ? 'This took too long. Please try again.' : 'Could not translate right now. Please try again.' };
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const body = await req.json().catch(() => null) || {};
  const device = String(body.device || '');
  if (!validDevice(device)) return json({ error: 'Please refresh the app and try again.' });
  const store = getStore('free-usage');
  const aiKey = 'ai:' + device + ':' + monthKey();

  if (body.action === 'status') return json(await statusOf(store, device));

  if (body.action === 'reserve') {
    const st = await statusOf(store, device);
    if (st.left <= 0) return json({ ...st, error: NONE_LEFT });
    await store.set(aiKey, String(st.used + 1));
    const token = crypto.randomBytes(12).toString('hex');
    await store.setJSON('qt:' + token, { device, at: Date.now() });
    return json({ token, ...(await statusOf(store, device)) });
  }

  if (body.action === 'translate') {
    const bullets = (Array.isArray(body.bullets) ? body.bullets : []).map(b => String(b || '').slice(0, 600)).filter(Boolean).slice(0, 15);
    const language = String(body.language || '').trim().slice(0, 40);
    if (!bullets.length || !language) return json({ error: 'There are no highlights to translate yet.' });
    const st = await statusOf(store, device);
    if (st.left <= 0) return json({ ...st, error: NONE_LEFT });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller){
        controller.enqueue(enc.encode(' '));
        const keep = setInterval(() => controller.enqueue(enc.encode(' ')), 3000);
        const result = await translateBullets(bullets, language);
        clearInterval(keep);
        let reply = result;
        if (!result.error) {
          await store.set(aiKey, String((Number(await store.get(aiKey)) || 0) + 1));
          reply = { bullets: result.bullets, ...(await statusOf(store, device)) };
        }
        controller.enqueue(enc.encode(JSON.stringify(reply)));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return json({ error: 'Unknown request.' });
};
