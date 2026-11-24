// While the window is in the background, a conversation that finishes a reply or stops to ask something
// says so with a system notification, and the Dock icon counts those conversations until the window is
// used again. In the window itself the sidebar already marks them, so nothing is sent while it has focus.
//
// A finished turn is announced only once things are quiet: goal and Ultra runs start their next turn at
// once (and Ultra sends its own notification when the task ends), and a stopped turn needs no message.

const SYMBOLS = { le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', approx: '≈', times: '×', cdot: '·', pm: '±', to: '→' };
const inlineMath = math => math.replace(/\\([a-zA-Z]+)/g, (_, name) => SYMBOLS[name] ?? '').replace(/\\[,;:! ]/g, ' ').replace(/[{}_]/g, '');
// Plain words for a notification: no code blocks, display formulas, Markdown marks or TeX commands.
const oneLine = text => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\$\$[\s\S]*?\$\$/g, ' ')
  .replace(/\$([^$\n]{1,80})\$/g, (_, math) => inlineMath(math))
  .replace(/[`*_#>|]+/g, '').replace(/\s+([,.;:!?)。,;:!?)])/g, '$1').replace(/\s+/g, ' ').trim();
const clip = (text, max = 160) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const replyText = message => oneLine((Array.isArray(message?.content) ? message.content : []).filter(c => c?.type === 'text').map(c => c.text).join(' '));

export function createAttention({ isFocused, notify, setBadge, titleOf, isWorking = () => false, settleMs = 1500, timers = globalThis }) {
  const waiting = new Set();  // conversations that finished or asked while you were away
  const replies = new Map();  // session id -> its latest assistant message
  const settling = new Map(); // session id -> timer before a finished turn is announced
  const looping = new Set();  // Ultra tasks in progress: they announce their own end
  const flag = (id, body) => {
    if (isFocused()) return;
    if (!waiting.has(id)) { waiting.add(id); setBadge(waiting.size); }
    notify({ id, title: clip(oneLine(titleOf(id)) || 'Conversation', 80), body: clip(body) });
  };
  const cancel = id => { timers.clearTimeout(settling.get(id)); settling.delete(id); };
  return {
    event(id, event) {
      if (event?.type === 'agent_start') cancel(id);
      else if (event?.type === 'message_end' && event.message?.role === 'assistant') replies.set(id, event.message);
      else if (event?.type === 'agent_settled') {
        cancel(id);
        settling.set(id, timers.setTimeout(() => {
          settling.delete(id);
          const reply = replies.get(id);
          replies.delete(id);
          if (!reply || looping.has(id) || isWorking(id) || reply.stopReason === 'aborted') return;
          flag(id, reply.stopReason === 'error' ? `Stopped with an error: ${oneLine(reply.errorMessage).split(/(?<=[.!?])\s/)[0] || 'the model request failed'}` : replyText(reply) || 'Finished.');
        }, settleMs));
      }
    },
    question(id, question) {
      const what = oneLine(question?.title || question?.message);
      flag(id, `${question?.permission ? 'Asks for permission' : 'Waiting for your answer'}${what ? `: ${what}` : ''}`);
    },
    ultra(id, active) { if (active) looping.add(id); else looping.delete(id); },
    // You are back: the Dock count goes; the sidebar still marks what changed.
    focused() { if (waiting.size) { waiting.clear(); setBadge(0); } },
    forget(id) { cancel(id); replies.delete(id); looping.delete(id); if (waiting.delete(id)) setBadge(waiting.size); },
  };
}
