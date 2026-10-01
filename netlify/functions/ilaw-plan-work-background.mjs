// This runs on Netlify's servers, not in the visitor's browser.
//
// 📝 ILAW Lesson Plan helper — BACKGROUND worker (Netlify allows up to 15 minutes, so a full
// plan always has time to finish). ilaw-plan.mjs takes the request and gives a ticket (jobId);
// this function writes the plan and saves it under the ticket; the app collects it with "status".
// (DepEd Order No. 016, s. 2026 — Intentions, Learning Experience,
// Assessing Learning, Ways Forward). It DRAFTS a plan from the teacher's own input; the teacher
// reviews and adapts it. DO 016 does not allow fully AI-generated lesson plans and asks that AI
// help be declared, so the printout carries an "AI-assisted, reviewed by the teacher" line.
// Each part is tagged to the PPST classroom-observation indicators the teacher selects, with what
// Level 7 (Outstanding for Proficient teachers) looks like — plus an observation-day checklist.
// Also works for corporate training and meetings (a session plan, without DepEd/COT parts).
// Counts as 1 of the device's free AI uses (same pool as free-ai.mjs).
// Needs ANTHROPIC_API_KEY as a Netlify environment variable.

import { getStore } from '@netlify/blobs';
export const config = { background: true };

const FREE_AI_USES = 5;   // keep the same as free-ai.mjs
const phNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString();
const monthKey = () => 'starter';   // one-time free load per device — no monthly reset
const validDevice = (d) => /^d-[a-z0-9]{12,40}$/.test(String(d || ''));
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

// PPST classroom-observable indicators (Proficient teachers) and what Level 7 looks like in the COT rubric.
const INDICATORS = {
  '1.1.2': ['Applied knowledge of content within and across curriculum teaching areas', 'accurate, in-depth and broad content knowledge, linked to other subjects and to real life'],
  '1.3.2': ['Ensured the positive use of ICT to facilitate the teaching and learning process', 'models responsible ICT use; addresses plagiarism, copyright and online etiquette'],
  '1.4.2': ['Used a range of teaching strategies that enhance learner achievement in literacy and numeracy skills', 'well-connected strategies that build critical literacy and/or numeracy as a significant part of the lesson'],
  '1.5.2': ['Applied a range of teaching strategies to develop critical and creative thinking, as well as other higher-order thinking skills', 'broad questioning and tasks that make learners analyze, evaluate and create; discussion across disciplines'],
  '1.6.2': ['Displayed proficient use of Mother Tongue, Filipino and English to facilitate teaching and learning', 'clear, accurate, level-appropriate language; strategic use of languages to deepen understanding'],
  '2.1.2': ['Established safe and secure learning environments through consistent implementation of policies, guidelines and procedures', 'learners can state and follow safety rules and procedures in every task'],
  '2.2.2': ['Maintained learning environments that promote fairness, respect and care to encourage learning', 'all learners feel accepted and safe to take learning risks; equal chances to participate'],
  '2.3.2': ['Managed classroom structure to engage learners in meaningful exploration, discovery and hands-on activities', 'organized individual and group structures for exploration, discovery and hands-on work'],
  '2.6.2': ['Managed learner behavior constructively by applying positive and non-violent discipline', 'clear routines, positive reinforcement and learner self-monitoring; no punitive language'],
  '3.1.2': ["Used differentiated, developmentally appropriate learning experiences to address learners' gender, needs, strengths, interests and experiences", 'tiered tasks, choices, varied pacing and support for different learners'],
  '3.2.2': ["Established a learner-centered culture responsive to learners' linguistic, cultural, socio-economic and religious backgrounds", 'examples and tasks drawn from learners\' own languages, cultures and communities'],
  '3.5.2': ['Adapted and used culturally appropriate teaching strategies for learners from indigenous groups', 'values Indigenous Knowledge Systems and Practices; culturally appropriate examples'],
  '4.1.2': ['Planned, managed and implemented developmentally sequenced teaching and learning processes to meet curriculum requirements', 'a clear sequence from activating prior knowledge to mastery and transfer, all aligned to the competency'],
  '4.5.2': ['Selected, developed, organized and used appropriate teaching and learning resources, including ICT, to address learning goals', 'varied resources (incl. ICT) adapted to learners, with options to show mastery'],
  '5.3.2': ['Used strategies for providing timely, accurate and constructive feedback to improve learner performance', 'specific, timely feedback; learners reflect and plan next steps; peer and self-assessment']
};

const TOOL = {
  name: 'ilaw_plan',
  description: 'Return the lesson or session plan draft.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      intentions: { type: 'object', properties: {
        contentStandard: { type: 'string' }, performanceStandard: { type: 'string' }, competency: { type: 'string' },
        objectives: { type: 'array', items: { type: 'object', properties: { domain: { type: 'string' }, text: { type: 'string' } }, required: ['domain', 'text'] } }
      }, required: ['objectives'] },
      learningExperience: { type: 'object', properties: {
        resources: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'object', properties: {
          phase: { type: 'string' }, minutes: { type: 'number' }, teacher: { type: 'string' }, learners: { type: 'string' },
          differentiation: { type: 'string' }, indicators: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, level: { type: 'string' } }, required: ['q', 'level'] } } },
          required: ['phase', 'minutes', 'teacher', 'learners'] } },
        integration: { type: 'string' }, values: { type: 'string' }
      }, required: ['resources', 'steps'] },
      assessingLearning: { type: 'object', properties: {
        checks: { type: 'array', items: { type: 'object', properties: { when: { type: 'string' }, how: { type: 'string' } }, required: ['when', 'how'] } },
        exitTask: { type: 'string' }, rubric: { type: 'string' },
        quiz: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, level: { type: 'string' }, answer: { type: 'string' } }, required: ['q', 'level', 'answer'] } }
      }, required: ['checks', 'quiz'] },
      waysForward: { type: 'object', properties: {
        reteach: { type: 'string' }, remediation: { type: 'string' }, enrichment: { type: 'string' },
        reflection: { type: 'array', items: { type: 'string' } }
      } },
      cot: { type: 'array', items: { type: 'object', properties: {
        indicator: { type: 'string' }, where: { type: 'string' }, lookFor: { type: 'string' } }, required: ['indicator', 'where', 'lookFor'] } },
      checklist: { type: 'array', items: { type: 'string' } }
    },
    required: ['title', 'intentions', 'learningExperience', 'assessingLearning', 'waysForward', 'checklist']
  }
};

function buildPrompt(f){
  const school = !/corporate|training|meeting|seminar|workshop/i.test(f.level);
  const chosen = f.indicators.filter(k => INDICATORS[k]);
  const indList = chosen.map(k => `- ${k} ${INDICATORS[k][0]} — Level 7 looks like: ${INDICATORS[k][1]}`).join('\n');
  if (school) {
    return `You help Filipino teachers DRAFT a lesson plan in the ILAW format of DepEd Order No. 016, s. 2026 (Intentions, Learning Experience, Assessing Learning, Ways Forward). The teacher will review, adapt and own the final plan — write a strong, practical draft they can build on, using their own ideas wherever they gave them.

Lesson: ${f.subject} · ${f.level} · ${f.duration} · Topic/competency: ${f.topic}${f.code ? ' · Code: ' + f.code : ''}
Learners: ${f.learners || 'not described — assume a typical public-school class with mixed abilities'}
Teacher's own ideas to build on: ${f.ideas || 'none given'}

Write for the MATATAG curriculum where it applies (for College, use course outcomes instead). Use simple, clear English.
INTENTIONS: content standard, performance standard and the learning competency (use the teacher's wording or the closest MATATAG competency; do not invent a code). Then 3 SMART objectives with measurable action verbs — one each for Knowledge, Skills and Attitude/Values.
LEARNING EXPERIENCE: resources (low-cost, available in public schools; ICT optional), then a developmentally sequenced flow whose minutes add up to exactly ${f.minutes} minutes: activating prior knowledge, motivation, explicit teaching with examples, guided practice in groups (hands-on/exploration), independent practice, generalization, application to real life. For each step write what the teacher does and what learners do, a differentiation note when useful, and which indicator numbers it shows. Add integration across subjects and a values connection.
HOTS (Higher-Order Thinking Skills) must be clearly visible: for each step from motivation onward, give 1–3 key discussion questions the teacher asks ("questions"), each labeled with its Bloom level (Remember, Understand, Apply, Analyze, Evaluate or Create). Most discussion questions must be Analyze, Evaluate or Create — open-ended "why / how / what if / which is better and why / design a…" questions tied to real life, that make learners explain their reasoning and respond to each other's answers. Include learner-to-learner discussion (think-pair-share, debate, small-group problem solving).
ASSESSING LEARNING: formative checks throughout (when + how, e.g. thumbs up, mini whiteboards, exit ticket), an exit task that requires higher-order thinking, a short rubric, and "quiz": a 5-item quick test with answers, each labeled with its Bloom level — at least 3 of the 5 at Analyze, Evaluate or Create (scenario or problem-based, not plain recall).
WAYS FORWARD: reteach, remediation, enrichment, and 3 reflection questions for the teacher.
COT: for EACH of these indicators the teacher's school observes, say exactly where in the plan it is shown and what the observer should see at Level 7:
${indList || '- (none selected)'}
CHECKLIST: 8–10 short reminders for observation day (before, during, after), e.g. post the objectives, prepare differentiated materials, call on all learners fairly, give specific feedback.
Be realistic: no plan can guarantee a rating — the observer rates the actual teaching. Fill in the ilaw_plan tool.`;
  }
  return `You help a trainer or facilitator DRAFT a session plan in the ILAW structure (Intentions, Learning Experience, Assessing Learning, Ways Forward). They will review and adapt it.

Session: ${f.subject} · ${f.level} · ${f.duration} · Topic: ${f.topic}
Participants: ${f.learners || 'working adults'}
Facilitator's own ideas: ${f.ideas || 'none given'}

INTENTIONS: leave contentStandard and performanceStandard empty; competency = the main session goal; 3 measurable objectives (Knowledge, Skills, Attitude).
LEARNING EXPERIENCE: materials, then a timed agenda whose minutes add up to exactly ${f.minutes} minutes (icebreaker, input, demonstration, group work/practice, sharing, wrap-up), with what the facilitator does and what participants do.
Give each agenda step 1–2 discussion questions ("questions") that make participants analyze, evaluate or apply ideas to their own work, labeled with Bloom level.
ASSESSING LEARNING: quick checks during the session, an end-of-session evaluation, and "quiz": 5 scenario-based questions with answers, labeled with Bloom level, mostly Analyze/Evaluate/Apply.
WAYS FORWARD: follow-up actions, support for those who need more help, and stretch tasks; 3 reflection questions for the facilitator.
COT: return an empty list. CHECKLIST: 8 practical facilitation reminders.
Fill in the ilaw_plan tool.`;
}

export default async (req) => {
  const body = await req.json().catch(() => null) || {};
  const jobId = String(body.jobId || '');
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return;
  const jobs = getStore({ name: 'ilaw-jobs', consistency: 'strong' });
  const results = getStore({ name: 'ilaw-results', consistency: 'strong' });
  const job = await jobs.get(jobId, { type: 'json' });
  if (!job) return;
  await jobs.delete(jobId);
  const f = job.f, device = job.device;
  const store = getStore({ name: 'free-usage', consistency: 'strong' });
  const aiKey = 'ai:' + device + ':' + monthKey();
  let reply;
  try {
    const used = Number(await store.get(aiKey)) || 0;
    if (used >= FREE_AI_USES) {
      reply = { error: "You've used your " + FREE_AI_USES + ' free AI uses. Thank you for trying the app!', used, limit: FREE_AI_USES, left: 0 };
    } else {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8000, system: buildPrompt(f),
          tools: [TOOL], tool_choice: { type: 'tool', name: 'ilaw_plan' },
          messages: [{ role: 'user', content: 'Draft the plan now.' }] })
      });
      const data = await res.json().catch(() => ({}));
      const out = res.ok && (data.content || []).find(b => b.type === 'tool_use');
      if (!out || !out.input) {
        console.log('ilaw-plan: AI error', res.status, JSON.stringify(data).slice(0, 300));
        reply = { error: res.ok ? 'Received an unexpected response. Please try again.' : 'Could not reach the lesson plan service (' + res.status + '). Please try again.' };
      } else {
        const now = (Number(await store.get(aiKey)) || 0) + 1;
        await store.set(aiKey, String(now));
        const plan = out.input;
        plan.cot = (Array.isArray(plan.cot) ? plan.cot : []).filter(c => INDICATORS[c.indicator]).map(c => ({ ...c, name: INDICATORS[c.indicator][0] }));
        reply = { plan, used: now, limit: FREE_AI_USES, left: Math.max(0, FREE_AI_USES - now) };
      }
    }
  } catch (e) {
    reply = { error: 'Could not make the plan right now. Please try again.' };
  }
  await results.setJSON(jobId, { done: true, at: Date.now(), ...reply });
};
