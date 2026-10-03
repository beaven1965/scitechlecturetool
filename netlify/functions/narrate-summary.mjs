// This runs on Netlify's servers, not in the visitor's browser.
//
// "🔊 Listen to translated highlights" — reads the TRANSLATED highlights aloud
// with OpenAI's clear voice ("nova", a woman's voice). Only the short highlights
// are read (never the whole transcript), so each listen costs about ₱1.
// Part of the free load: each phone/laptop gets FREE_LISTENS listens, one time
// (5 AI translations × 2 listens each). Replaying a voice already heard is free
// (the phone keeps it). A daily cap for everyone together protects the bill.
// Needs OPENAI_API_KEY as a Netlify environment variable.

import { getStore } from '@netlify/blobs';

const MAX_CHARS = 2500;
const FREE_LISTENS = 10;          // ← AI voice listens per device (one-time free load)
const GLOBAL_DAILY_LISTENS = 150; // ← safety cap for all users together per day (about ₱150 at most)

const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return json({ error: 'The AI voice is not set up on the server yet.' });

  const body = await req.json().catch(() => null) || {};
  const device = String(body.device || '');
  if (!validDevice(device)) return json({ error: 'Please reload the page and try again.' });
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return json({ error: 'There are no highlights to read yet.' });

  const store = getStore('narrate-free');
  const key = 'n:' + device;
  const used = Number(await store.get(key)) || 0;
  if (used >= FREE_LISTENS) return json({ error: "You've used your " + FREE_LISTENS + ' free AI voice listens. The phone-voice Listen box still works, and replaying a voice you already heard is free.' });
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // Philippine date
  const dayKey = 'day:' + day;
  const today = Number(await store.get(dayKey)) || 0;
  if (today >= GLOBAL_DAILY_LISTENS) return json({ error: 'The AI voice is very busy today. Please try again tomorrow. The phone-voice Listen box still works.' });

  // Stream the answer: Netlify allows a streaming reply up to 60 seconds.
  const stream = new ReadableStream({
    async start(controller){
      try {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + openaiKey },
          body: JSON.stringify({ model: 'tts-1', voice: 'nova', input: text, response_format: 'mp3' })
        });
        if (res.ok) {
          controller.enqueue(new Uint8Array(await res.arrayBuffer()));
          await store.set(key, String(used + 1));
          await store.set(dayKey, String(today + 1));
        } else {
          console.log('narrate-summary: voice service error', res.status);
        }
      } catch (e) { console.log('narrate-summary: no connection'); }
      controller.close();          // an empty reply means "it didn't work" — the app says so
    }
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
};
