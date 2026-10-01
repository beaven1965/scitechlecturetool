// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real OpenAI API key (set as an Environment Variable in Netlify)
// so it's never visible to anyone using the app.


// ---- Free load limits (counted per phone/laptop, on the server) ----
// Each device gets a one-time free load: FREE_MINUTES of transcription and FREE_AI_USES AI uses
// (like free cellphone load — no monthly reset, no expiry; unused minutes stay until used).
const { getStore, connectLambda } = require('@netlify/blobs');
const FREE_MINUTES = 60;            // ← free recording minutes per device (one-time)
const FREE_AI_USES = 5;             // ← free lesson plans + quizzes + translations per device (one-time)
const GLOBAL_DAILY_MINUTES = 300;   // ← safety cap for everyone together per day (protects your OpenAI bill)
const phNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString();
const monthKey = () => 'starter';   // one-time free load per device — no monthly reset
const dayKey = () => phNow().slice(0, 10);
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an OpenAI API key yet.' }) };
    }

    const { audioBase64, mimeType, device, seconds } = JSON.parse(event.body || '{}');
    if (!audioBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No audio provided' }) };
    }
    if (!validDevice(device)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please refresh the app and try again.' }) };
    }

    // Count this piece of audio against the device's free minutes.
    connectLambda(event);
    const usage = getStore('free-usage');
    const mKey = 'min:' + device + ':' + monthKey();
    const gKey = 'global-min:' + dayKey();
    const usedSec = Number(await usage.get(mKey)) || 0;
    const globalSec = Number(await usage.get(gKey)) || 0;
    if (usedSec >= FREE_MINUTES * 60) {
      return { statusCode: 429, body: JSON.stringify({ error: "You've used your " + FREE_MINUTES + ' free recording minutes. Your recording is still saved in the Library.', limit: true }) };
    }
    if (globalSec >= GLOBAL_DAILY_MINUTES * 60) {
      return { statusCode: 429, body: JSON.stringify({ error: 'The app is very busy today. Your recording is saved — please try turning it into text again tomorrow.', limit: true }) };
    }
    const bytes = Math.floor(audioBase64.length * 3 / 4);
    const pieceSec = Math.min(150, Math.max(Number(seconds) || 0, bytes / 32000));   // never less than the audio size allows

    const binary = Buffer.from(audioBase64, 'base64');
    const ext = (mimeType && mimeType.includes('wav')) ? 'wav' : 'webm';
    const blob = new Blob([binary], { type: mimeType || 'audio/webm' });

    const formData = new FormData();
    formData.append('file', blob, 'recording.' + ext);
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');
    formData.append('temperature', '0');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: formData
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Transcription failed (' + res.status + ').', detail: errText })
      };
    }

    const data = await res.json();
    const nowUsed = (Number(await usage.get(mKey)) || 0) + Math.round(pieceSec);
    await usage.set(mKey, String(nowUsed));
    await usage.set(gKey, String((Number(await usage.get(gKey)) || 0) + Math.round(pieceSec)));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: data.text, minutesLeft: Math.max(0, Math.floor((FREE_MINUTES * 60 - nowUsed) / 60)) })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
