import { createEngine } from './engine/index.js';
const e = await createEngine({ headless: true });
try {
  await e.open('https://www.w3schools.com/html/tryit.asp?filename=tryhtml_basic');
  const v = await e.observe({ verbosity: 'full' });
  console.log('nodes:', v.nodes.length, 'framed:', v.nodes.filter(n=>n.frameId).length);
  console.log(v.nodes.slice(0, 40).map(n=>`${n.indent} ${n.role}:${n.name.slice(0,40)}${n.frameId?' [F]':''}`).join('\n'));
} finally { await e.close(); }
