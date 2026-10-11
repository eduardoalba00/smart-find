// Scores page passages against a question with Jev. Passages are sent in batches of 8 per
// request (one Score question per passage), which tested as accurate as one request per
// passage while being about twice as fast and making 8x fewer requests.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const BATCH_SIZE = 8;
const CONCURRENCY = 16;

const LEVELS = [
  "Unrelated: the passage does not address the question.",
  "Related: the passage is on the question's topic but does not answer it.",
  "Answers: the passage directly answers or addresses the question.",
];

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function ask(apiKey, state, questions, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal,
    });
    if ((res.status === 429 || res.status === 529) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      continue;
    }
    if (res.status === 401) throw new JevError("Your TypeSafe API key was rejected. Check it in the extension options.", 401);
    if (!res.ok) throw new JevError(`Jev returned ${res.status}`, res.status);
    return res.json();
  }
}

const normalise = (answer) => {
  const levels = Object.keys(answer.legend).map(Number);
  return (answer.score - Math.min(...levels)) / (Math.max(...levels) - Math.min(...levels));
};

// batches: arrays of { id, path, previous, text }, already in the order they should run
// (closest to what the reader is looking at first). Calls onScores([[id, score], ...]) as each
// batch lands. Resolves with token usage.
export async function scoreBatches({ apiKey, title, question, batches, signal, onScores }) {
  let next = 0;
  let tokens = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) return;
      const group = batches[next++];
      const passages = Object.fromEntries(
        group.map((p) => [`passage_${p.id}`, { section: p.path || "(top of page)", previous_sentence: p.previous, passage: p.text }]),
      );
      const questions = Object.fromEntries(
        group.map((p) => [
          `p${p.id}`,
          {
            type: "score",
            instructions: `How well does passage_${p.id} (and only that passage) answer this question from someone reading the page: "${question}"`,
            criteria: LEVELS,
          },
        ]),
      );
      const r = await ask(apiKey, { page_title: title, passages }, questions, signal);
      tokens += r.usage?.input_tokens ?? 0;
      onScores(group.map((p) => [p.id, normalise(r.answers[`p${p.id}`])]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return { tokens };
}
