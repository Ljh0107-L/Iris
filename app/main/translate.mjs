// Translating a piece of text with a model of the person's own choosing (one of those set up in Settings →
// Models): the right panel uses it to show the agent's thinking in their language. The request is the one a
// conversation with that model sends (Pi's own, pi-ai), so whatever the model's provider takes in a conversation
// it takes here too: its API, address, headers, and its thinking at the level chosen in Settings → Translation
// (off, unless the person chooses otherwise; a level the model does not offer becomes the nearest one it does).
export const TRANSLATE_MAX_CHARS = 12000;
const instructions = language => `Translate the user's text into ${language}. It is an AI coding agent's reasoning notes. Keep code, commands, file paths, identifiers and numbers exactly as they are, and keep the paragraph breaks: one paragraph of translation for each paragraph of text, separated by a blank line. Reply with the translation only: no preface, no quotes, no notes.`;

// Pi says a refusal as the status and the body ("400 {"error":{"message":…}}"): the provider's message is the reason.
function reasonOf(raw) {
  const text = String(raw ?? '').trim();
  const match = /^(\d{3})\s+(\{[\s\S]*\})$/.exec(text);
  if (match) {
    try {
      const body = JSON.parse(match[2]), message = body?.error?.message ?? body?.message ?? body?.detail;
      if (typeof message === 'string' && message.trim()) return ` (${match[1]}): ${message.trim()}`;
    } catch { /* said as it came */ }
  }
  const status = /^(\d{3})\b\s*([\s\S]*)$/.exec(text);
  return status ? ` (${status[1]})${status[2] ? `: ${status[2]}` : ''}` : null;
}

let pi = null;
const loadPi = () => pi ??= Promise.all([import('@earendil-works/pi-ai/compat'), import('@earendil-works/pi-ai/models')])
  .then(([compat, models]) => ({ completeSimple: compat.completeSimple, clampThinkingLevel: models.clampThinkingLevel }));

// model: the model as Pi lists it (its api, baseUrl, reasoning, thinkingLevelMap, compat…); headers and apiKey:
// its provider's. thinking: off, minimal, low, medium, high, xhigh or max.
export async function translateText({ model, headers, apiKey, text, language, thinking = 'off', timeoutMs = 60000, fetch, load = loadPi }) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  if (source.length > TRANSLATE_MAX_CHARS) throw new Error('This text is too long to translate in one piece.');
  if (!model?.id || !model?.api || !language) throw new Error('Choose a model and a language for translation first.');
  if (!/^https?:\/\//i.test(model.baseUrl ?? '')) throw new Error('The translation model’s provider has no address.');
  const { completeSimple, clampThinkingLevel } = await load();
  const level = model.reasoning ? clampThinkingLevel(model, thinking || 'off') : 'off';
  const signal = AbortSignal.timeout(timeoutMs);
  let reply;
  try {
    reply = await completeSimple({ ...model, headers: { ...(model.headers ?? {}), ...(headers ?? {}) } },
      { systemPrompt: instructions(language), messages: [{ role: 'user', content: source, timestamp: Date.now() }] },
      { ...(apiKey ? { apiKey } : {}), ...(level !== 'off' ? { reasoning: level } : {}), maxTokens: 4096, maxRetries: 1, signal, ...(fetch ? { fetch } : {}) });
  } catch (error) {
    throw new Error(signal.aborted ? 'The translation model did not answer in time.' : `The translation model could not be reached: ${error?.message ?? error}`);
  }
  if (signal.aborted || reply?.stopReason === 'aborted') throw new Error('The translation model did not answer in time.');
  if (reply?.stopReason === 'error') {
    const refused = reasonOf(reply.errorMessage);
    throw new Error(refused ? `The translation model refused the request${refused.slice(0, 400)}` : `The translation request failed: ${String(reply.errorMessage ?? '').trim().slice(0, 400) || 'no reason given'}`);
  }
  const translated = (reply?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('').trim();
  if (!translated) throw new Error(reply?.stopReason === 'length' ? 'The translation model spent its whole answer thinking. Choose less thinking in Settings → Translation.' : 'The translation model returned nothing.');
  return translated;
}
