// This runs on Netlify's servers, not in the visitor's browser.
// It holds the real Anthropic API key (set as an Environment Variable
// in Netlify) so it's never visible to anyone using the app.
//
// Given a sermon/lecture transcript, generates a study quiz: a mix of
// multiple-choice and short-answer questions with an answer key, meant
// for a teacher/pastor to print and hand out to students.

const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured with an Anthropic API key yet.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const transcript = (body.transcript || '').trim();
    const takeaway = (body.takeaway || '').trim();
    const title = (body.title || '').trim();

    if (!transcript) {
      return { statusCode: 400, body: JSON.stringify({ error: 'There is no transcript to build a quiz from.' }) };
    }

    // Free month: a quiz must first be reserved in free-ai.mjs (one quiz = one AI use, whatever the number of parts).
    connectLambda(event);
    const tokenRec = await getStore('free-usage').get('qt:' + String(body.quizToken || '').replace(/[^a-f0-9]/g, ''), { type: 'json' });
    if (!tokenRec || Date.now() - tokenRec.at > 15 * 60 * 1000) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Please tap Generate Quiz again.' }) };
    }

    // Guard against extremely long transcripts blowing the request budget —
    // the quiz only needs the substance, not every word.
    const trimmedTranscript = transcript.length > 12000 ? transcript.slice(0, 12000) + ' …' : transcript;

    // One question type per request (the app asks for several types at the same time).
    const TYPES = {
      multiple_choice: { n: 10, max: 15, shape: '{"type":"multiple_choice","question":"...","options":["...","...","...","..."],"answer":"exact text of the correct option"}',
        rule: 'exactly 4 options each; "answer" must be copied exactly from options.' },
      true_false: { n: 10, max: 15, shape: '{"type":"true_false","question":"a statement","answer":"True"}',
        rule: '"question" is a clear statement; "answer" is exactly "True" or "False". Mix true and false statements about evenly.' },
      fill_blank: { n: 5, max: 10, shape: '{"type":"fill_blank","question":"a sentence with ____ for the missing word or phrase","answer":"the missing word or phrase"}',
        rule: 'each sentence has exactly one blank written as ____; the answer is a key word, name or short phrase from the talk.' },
      matching: { n: 5, max: 8, shape: '{"type":"matching","question":"Match Column A with Column B.","pairs":[{"left":"term or name","right":"its meaning or description"}]}',
        rule: 'return exactly ONE matching item whose "pairs" array has the requested number of pairs; every right side must clearly fit only one left side.' },
      short_answer: { n: 5, max: 10, shape: '{"type":"short_answer","question":"...","answer":"one short model sentence"}',
        rule: 'answers are one short sentence.' },
      essay: { n: 2, max: 5, shape: '{"type":"essay","question":"an open question that asks the student to explain or apply","answer":"2-3 key points a good answer should include"}',
        rule: 'questions invite reflection or application in a paragraph.' }
    };
    const type = TYPES[body.type] ? body.type : null;
    let systemPrompt;
    if (type) {
      const t = TYPES[type];
      const n = Math.max(1, Math.min(t.max, parseInt(body.count, 10) || t.n));
      const what = type === 'matching' ? 'one matching item with exactly ' + n + ' pairs' : 'exactly ' + n + ' questions';
      systemPrompt = `You are a careful teacher's assistant for a tool used for classroom lectures, trainings and meetings. From the transcript, write ${what} of this type: ${type}. Respond with ONLY a JSON object (no markdown, no code fences, no extra text) in this exact shape:
{"questions":[ ${t.shape} ]}
Rules: ${t.rule} Base every item strictly on what the transcript actually says — never invent facts. Keep wording clear and simple for a general audience of students. Keep each item concise.`;
    } else {
      systemPrompt = `You are a careful teacher's assistant for a classroom tool called ScitechLectureTool, used for lectures, classes, trainings and meetings. Given a transcript, write a short comprehension quiz suitable for a teacher or trainer to hand out to students afterward. Respond with ONLY a JSON object (no markdown, no code fences, no extra text) in this exact shape:
{"questions":[ ${TYPES.multiple_choice.shape}, ${TYPES.short_answer.shape} ]}
Write exactly 15 questions: FIRST exactly 10 multiple_choice questions (each with exactly 4 options and the answer being the exact text of the correct option), THEN exactly 5 short_answer questions whose answers are one short sentence. Base every question strictly on the content of the transcript — do not invent facts. Keep each question and answer concise.`;
    }

    const userContent = (title ? 'Title: ' + title + '\n\n' : '') +
      (takeaway ? 'Main takeaway: ' + takeaway + '\n\n' : '') +
      'Transcript:\n' + trimmedTranscript;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: type === 'matching' || type === 'fill_blank' || type === 'essay' ? 1500 : 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach the quiz service (' + res.status + ').', detail: errText }) };
    }

    const data = await res.json();
    const raw = (data.content || []).map(b => b.text || '').join('').trim();
    let cleaned = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const fb = cleaned.indexOf('{'), lb = cleaned.lastIndexOf('}');
    if (fb !== -1 && lb > fb) cleaned = cleaned.slice(fb, lb + 1);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Received an unexpected response. Please try again.' }) };
    }

    if (parsed && Array.isArray(parsed.questions) && type) {
      parsed.questions = parsed.questions.filter(q => q && q.type === type && (type !== 'matching' || (Array.isArray(q.pairs) && q.pairs.length >= 2)));
    }
    if (!parsed || !Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Received an unexpected response. Please try again.' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
