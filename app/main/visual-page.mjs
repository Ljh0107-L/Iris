// The page of a visual an agent showed (show_visual), as the conversation's frame loads it: the agent's HTML with
// a few lines of Iris's own put in front of it.
//
// - It stays a standards-mode page: the agent's <!doctype> (or one Iris adds) comes first, Iris's lines after it.
//   Put before the doctype, they would turn the page into a quirks-mode one, where a body fills the frame and
//   content set in its middle floats in empty space.
// - It takes the conversation's colour scheme (light or dark), so the frame is see-through: a page that paints no
//   background of its own sits on the conversation, as text does. (A frame whose page has another scheme than the
//   frame itself gets an opaque white or black backdrop.)
// - It is written in the conversation's typeface unless it names one of its own (not the browser's Times).
// - It has no margin of its own: the page lines up with the conversation's text. Its body holds its children's
//   margins (a flow root), so a heading's or a paragraph's margin is measured with the page, not cut off. (A page
//   that sets its body's display has its own way: its rule comes after these.)
// - It tells the conversation how tall it is, whenever that changes, so the frame is as tall as the page.
// - iris.send(text) puts a message in the person's message box (the conversation decides what to do with it).
// - Esc inside the page, that the page does not use itself, is passed on (it leaves the full window).
const helper = theme => `<meta name="color-scheme" content="${theme}"><style>html,body{margin:0}body{display:flow-root}:root{color-scheme:${theme};font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}</style><script>(()=>{
window.iris={send(text){parent.postMessage({iris:'send',text:String(text??'').slice(0,4000)},'*')}};
let last=0;
const measure=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);
const h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+parseFloat(s.marginTop||0)+parseFloat(s.marginBottom||0));
if(h>0&&Math.abs(h-last)>1){last=h;parent.postMessage({iris:'size',height:h},'*')}};
const watch=()=>{measure();if(document.body)new ResizeObserver(measure).observe(document.body)};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',watch);else watch();
addEventListener('load',measure);
addEventListener('keydown',e=>{if(e.key==='Escape')setTimeout(()=>{if(!e.defaultPrevented)parent.postMessage({iris:'key',key:'Escape'},'*')})});
})();</script>`;

export function visualPage(page, theme) {
  const scheme = theme === 'light' ? 'light' : 'dark';
  const doctype = /^\s*(<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(page);
  return doctype ? doctype[0] + helper(scheme) + page.slice(doctype[0].length) : `<!doctype html>${helper(scheme)}${page}`;
}
