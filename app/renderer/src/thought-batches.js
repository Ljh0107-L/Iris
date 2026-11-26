// Translating a thought in batches of its paragraphs rather than one request a paragraph: each request costs a
// round trip, and a fast model finishes several paragraphs in the time one is translated. The paragraphs that
// have finished since the last batch go out together once there are enough of them (BATCH_MIN_TOKENS), once
// the first of them has waited long enough (BATCH_WAIT_MS: a slow model is not kept waiting for a batch to
// fill), or once the thought is over; and only while a request may go out, so that what piles up while the
// requests are busy goes in the next one (up to BATCH_MAX_TOKENS a request).
export const BATCH_MIN_TOKENS = 160, BATCH_MAX_TOKENS = 1200, BATCH_WAIT_MS = 1500;

const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;
// About how many tokens: a CJK character is about one, other text about four characters to one.
export function estimateTokens(text) {
  let wide = 0, length = 0;
  for (const ch of String(text ?? '')) { length++; if (WIDE.test(ch)) wide++; }
  return wide + Math.ceil((length - wide) / 4);
}

// ends: where each batch so far ends (an index into finished, exclusive). Returns the ends with the batches
// that may go out now added: slots is how many requests may go out, waited how long the first paragraph after
// the last batch has waited, complete whether the thought is over (all of it is in finished).
export function nextBatches({ finished, ends, complete, waited, slots, min = BATCH_MIN_TOKENS, max = BATCH_MAX_TOKENS, wait = BATCH_WAIT_MS }) {
  const out = [...ends];
  let start = out.at(-1) ?? 0;
  for (let free = slots; free > 0 && start < finished.length; free--) {
    const tokens = finished.slice(start).reduce((n, p) => n + estimateTokens(p), 0);
    if (!complete && tokens < min && waited < wait) break;
    let end = start, n = 0;
    do { n += estimateTokens(finished[end]); end++; } while (end < finished.length && n + estimateTokens(finished[end]) <= max);
    out.push(end);
    start = end;
  }
  return out;
}

// The batches as texts, with the paragraphs each covers.
export const batchesOf = (finished, ends) => ends.map((end, i) => {
  const from = i ? ends[i - 1] : 0;
  return { from, to: end, text: finished.slice(from, end).join('\n\n') };
});

// The translation of a batch, paragraph by paragraph when it kept the paragraphs apart as they were (it is
// asked to); otherwise as a whole, in place of the batch's first paragraph.
export function translatedParagraphs(batch, translation) {
  const parts = String(translation ?? '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const count = batch.to - batch.from;
  return parts.length === count ? parts : [parts.join('\n\n'), ...Array(Math.max(0, count - 1)).fill(null)];
}
