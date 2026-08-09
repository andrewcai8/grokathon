import { writeFile } from "node:fs/promises";
const API = "http://localhost:3000";
const post = (p, b) => fetch(API+p, {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(r=>r.json());
const QUESTION = "help me pick a car under $30k";

console.log("1. board:", QUESTION);
const made = await post("/api/board/options", { prompt: QUESTION });
if (!made.board) throw new Error("failed: " + JSON.stringify(made).slice(0,200));
const board = made.board;
console.log("   roots:", board.root_ids.map(r=>board.nodes[r].title).join(" | "));

console.log("2. expanding each root (send our own node — survives a dev reload)");
for (const rid of board.root_ids) {
  const parent = board.nodes[rid];
  const r = await post("/api/expand", {
    nodeId: rid, fork: "deeper", kind: "options",
    node: parent, ancestors: [QUESTION],
  });
  if (!r.children?.length) { console.log("   ->", rid, "ERR", r.error); continue; }
  for (const c of r.children) board.nodes[c.id] = c;
  parent.children_ids = r.children.map(c=>c.id);
  if (r.axis) parent.axis = r.axis;
  console.log("   ->", r.children.map(c=>c.title).join(" | "));
}

const nodes = Object.values(board.nodes);
const need = nodes.filter(n => n.media?.alt && !n.media?.url);
console.log(`3. generating ${need.length} images (4 at a time)…`);
let done = 0; const q = [...need];
await Promise.all(Array.from({length:4}, async () => {
  while (q.length) { const n = q.shift();
    try { const r = await post("/api/image", { prompt: n.media.alt });
      if (r.url) { n.media.url = r.url; done++; } else console.log("   fail:", n.title, r.error);
    } catch (e) { console.log("   err:", n.title, e.message); } }
}));
console.log(`   ${done}/${need.length} cached`);

board.kind = "options";
board.seed = { ...board.seed, name: "options-preset", snapshot: true };
await writeFile(".snapshots/options-preset.json", JSON.stringify(board, null, 2));
console.log("4. wrote preset —", nodes.length, "nodes,", nodes.filter(n=>n.media?.url).length, "with images");
