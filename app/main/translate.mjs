// Translating a piece of text with a model of the person's own choosing (one of those set up in Settings →
// Models): the right panel uses it to show the agent's thinking in their language. One request, no streaming.
import { providerBaseUrl, requestHeaders } from './custom-providers.mjs';

const CHAT = 'openai-completions', RESPONSES = 'openai-responses', ANTHROPIC = 'anthropic-messages', GOOGLE = 'google-generative-ai';
export const TRANSLATE_MAX_CHARS = 12000;
const instructions = language => `Translate the user's text into ${language}. It is an AI coding agent's reasoning notes. Keep code, commands, file paths, identifiers and numbers exactly as they are, and keep the paragraph breaks. Reply with the translation only: no preface, no quotes, no notes.`;

// What to send, and where in the reply the text is, for each kind of API a provider can speak.
function request(api, base, model, system, text) {
  // No thinking: translating needs none, and a reasoning model behind an Anthropic-style endpoint (a relay to
  // Qwen, say) otherwise thinks for seconds before each paragraph.
  if (api === ANTHROPIC) return { url: `${base}/v1/messages`, body: { model, max_tokens: 4096, system, messages: [{ role: 'user', content: text }], thinking: { type: 'disabled' } },
    read: reply => (reply?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('') };
  if (api === GOOGLE) return { url: `${base}/models/${encodeURIComponent(model)}:generateContent`, body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text }] }] },
    read: reply => (reply?.candidates?.[0]?.content?.parts ?? []).filter(part => !part?.thought).map(part => part?.text ?? '').join('') };
  if (api === RESPONSES) return { url: `${base}/responses`, body: { model, instructions: system, input: text, store: false },
    read: reply => typeof reply?.output_text === 'string' ? reply.output_text
      : (reply?.output ?? []).flatMap(item => item?.type === 'message' ? item.content ?? [] : []).filter(part => part?.type === 'output_text').map(part => part.text).join('') };
  if (![CHAT, 'mistral-conversations'].includes(api)) throw new Error(`Translation cannot use this model: its API (${api ?? 'unknown'}) is not one it can speak. Choose another model.`);
  // Chat completions, which Mistral's API accepts too.
  return { url: `${api === CHAT ? base : `${base}/v1`}/chat/completions`, body: { model, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], stream: false },
    read: reply => { const content = reply?.choices?.[0]?.message?.content; return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''; } };
}

export async function translateText({ api, baseUrl, headers, apiKey, model, text, language, fetch = globalThis.fetch, timeoutMs = 60000 }) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  if (source.length > TRANSLATE_MAX_CHARS) throw new Error('This text is too long to translate in one piece.');
  if (!model || !language) throw new Error('Choose a model and a language for translation first.');
  const base = providerBaseUrl(api, baseUrl);
  if (!/^https?:\/\//i.test(base)) throw new Error('The translation model’s provider has no address.');
  const { url, body, read } = request(api, base, model, instructions(language), source);
  const ask = async payload => {
    let response;
    try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...requestHeaders(api, apiKey, headers) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (error) { throw new Error(error?.name === 'TimeoutError' ? 'The translation model did not answer in time.' : `The translation model could not be reached: ${error?.message ?? error}`); }
    const raw = await response.text();
    let reply = null;
    try { reply = JSON.parse(raw); } catch { /* not JSON: an error page */ }
    return { response, reply, raw };
  };
  let { response, reply, raw } = await ask(body);
  // An endpoint that does not take the switch that turns thinking off is asked again without it.
  if (response.status === 400 && body.thinking && /thinking/i.test(raw)) {
    const { thinking, ...plain } = body;
    void thinking;
    ({ response, reply } = await ask(plain));
  }
  if (!response.ok) throw new Error(`The translation model refused the request (${response.status})${reply?.error?.message ? `: ${String(reply.error.message).slice(0, 200)}` : ''}`);
  const translated = String(read(reply) ?? '').trim();
  if (!translated) throw new Error('The translation model returned nothing.');
  return translated;
}
