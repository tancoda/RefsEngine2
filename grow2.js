// grow2.js  —  memory-efficient, checkpoint-based tree grower
//
// Usage:
//   node --max-old-space-size=4096 grow2.js grow [targetGen]
//       Grows from current checkpoint to targetGen (default: current+1).
//       Safe to interrupt at any time — resumes from mid-generation cursor.
//
//   node grow2.js status
//       Show checkpoint state and disk usage.
//
//   node grow2.js search ax bx cx ay by cy
//       Search for a vertex (D4-aware). Outputs search_path.json.
//
// ── Checkpoint layout ─────────────────────────────────────────────────────────
//
//   checkpoints/
//     seen_keys.json          — JSON array, all canonical keys ever added
//     gen_N/
//       nodes.ndjson          — completed leaf nodes (append-only during growth)
//       meta.json             — { gen, nodeCount, nextId }  written on completion
//     gen_N+1/                — the generation currently being grown
//       nodes.ndjson          — output, appended as batches complete
//       progress.json         — { leavesProcessed, nextId, seenSize }
//                               updated every CHECKPOINT_EVERY_N_LEAVES leaves
//
// ── Resuming a partial gen ────────────────────────────────────────────────────
//
//   On restart, if gen_N+1/progress.json exists we:
//     1. Load seen_keys.json (which was flushed at last checkpoint)
//     2. Skip the first `leavesProcessed` lines of gen_N/nodes.ndjson
//     3. Append to gen_N+1/nodes.ndjson from where we left off
//     4. Resume nextId from progress.json
//
// ── Memory model ──────────────────────────────────────────────────────────────
//
//   Parent process: holds only the `seen` Set (strings) + one batch in memory.
//   Child processes: expand BATCH_SIZE leaves, then exit (RAM fully released).
//   seen_keys.json: flushed to disk every CHECKPOINT_EVERY_N_LEAVES leaves,
//                   so worst-case lost work on crash = one checkpoint interval.

'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');

// ── Tuning knobs ──────────────────────────────────────────────────────────────
const BATCH_SIZE              = 20;   // leaves per child process (lower = less RAM/child)
const CHECKPOINT_EVERY_N_LEAVES = 500; // flush seen_keys + progress every N source leaves
const PROGRESS_INTERVAL_MS    = 15_000; // log a progress line every 15 seconds
// ─────────────────────────────────────────────────────────────────────────────

const HERE      = __dirname;
const RBB2_PATH = path.join(HERE, 'rbb2.js');
const CKPT_DIR  = path.join(HERE, 'checkpoints');
const SEEN_PATH = path.join(CKPT_DIR, 'seen_keys.json');

fs.mkdirSync(CKPT_DIR, { recursive: true });

// ── Load rbb2 library source ──────────────────────────────────────────────────
const rbb2Full  = fs.readFileSync(RBB2_PATH, 'utf8');
const MARKER    = '// Bootstrap + two-generation growth';
const markerIdx = rbb2Full.indexOf(MARKER);
if (markerIdx === -1) { console.error('Marker not found in rbb2.js'); process.exit(1); }
const LIB_SRC   = rbb2Full.slice(0, markerIdx);

// ── Child-process runner ──────────────────────────────────────────────────────
function runInChild(code, inputData) {
  const inPath     = path.join(os.tmpdir(), '_g2_in.json');
  const outPath    = path.join(os.tmpdir(), '_g2_out.json');
  const runnerPath = path.join(os.tmpdir(), '_g2_runner.js');

  if (inputData !== undefined)
    fs.writeFileSync(inPath, JSON.stringify(inputData));

  fs.writeFileSync(runnerPath,
    `'use strict';\nconst fs = require('fs');\n` +
    LIB_SRC + '\n' +
    `const _inPath  = ${JSON.stringify(inPath)};\n` +
    `const _outPath = ${JSON.stringify(outPath)};\n` +
    code
  );
  execFileSync(process.execPath, [runnerPath], { stdio: 'inherit' });

  if (!fs.existsSync(outPath)) return null;
  const r = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  fs.unlinkSync(outPath);
  return r;
}

// ── Paths ─────────────────────────────────────────────────────────────────────
const genDir      = g => path.join(CKPT_DIR, `gen_${g}`);
const nodesPath   = g => path.join(genDir(g), 'nodes.ndjson');
const metaPath    = g => path.join(genDir(g), 'meta.json');
const progressPath= g => path.join(genDir(g), 'progress.json');

function readMeta(g) {
  const p = metaPath(g);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function currentGen() {
  if (!fs.existsSync(CKPT_DIR)) return -1;
  let g = -1;
  for (const d of fs.readdirSync(CKPT_DIR)) {
    const m = d.match(/^gen_(\d+)$/);
    if (m && fs.existsSync(metaPath(parseInt(m[1])))) g = Math.max(g, parseInt(m[1]));
  }
  return g;
}

// ── seen_keys helpers ─────────────────────────────────────────────────────────
function loadSeenKeys() {
  if (!fs.existsSync(SEEN_PATH)) return new Set();
  const raw  = fs.readFileSync(SEEN_PATH, 'utf8');
  const arr  = JSON.parse(raw);
  const seen = new Set(arr);
  log(`Loaded seen_keys.json: ${fmt(seen.size)} keys  (${fmtBytes(raw.length)})`);
  return seen;
}

function saveSeenKeys(seen) {
  const data = JSON.stringify([...seen]);
  fs.writeFileSync(SEEN_PATH + '.tmp', data);
  fs.renameSync(SEEN_PATH + '.tmp', SEEN_PATH);  // atomic replace
}

// ── Async NDJSON reader ───────────────────────────────────────────────────────
async function readNdjson(filePath, cb) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (t) cb(JSON.parse(t));
  }
}

async function countNdjson(filePath) {
  let n = 0;
  if (fs.existsSync(filePath)) await readNdjson(filePath, () => n++);
  return n;
}

// ── Formatting helpers ────────────────────────────────────────────────────────
const fmt      = n  => n.toLocaleString();
const fmtSec   = ms => (ms / 1000).toFixed(1) + 's';
const fmtBytes = b  => b > 1e9 ? (b/1e9).toFixed(2)+'GB' : b > 1e6 ? (b/1e6).toFixed(1)+'MB' : (b/1e3).toFixed(0)+'KB';
const fmtMem   = () => {
  const m = process.memoryUsage();
  return `heap=${fmtBytes(m.heapUsed)}/${fmtBytes(m.heapTotal)} rss=${fmtBytes(m.rss)}`;
};
const fmtRate  = (n, ms) => ms > 0 ? (n / (ms/1000)).toFixed(1)+'/s' : '?/s';
const pad2     = n => String(n).padStart(2, '0');
const fmtETA  = (done, total, elapsedMs) => {
  if (done === 0 || total === 0) return '?';
  const msPerItem = elapsedMs / done;
  const remaining = Math.max(0, total - done);
  const etaSec    = Math.round(remaining * msPerItem / 1000);
  const h = Math.floor(etaSec / 3600);
  const m = Math.floor((etaSec % 3600) / 60);
  const s = etaSec % 60;
  return h > 0 ? `${h}h${pad2(m)}m` : m > 0 ? `${m}m${pad2(s)}s` : `${s}s`;
};

let _logStart = Date.now();
function log(...args) {
  const elapsed = ((Date.now() - _logStart) / 1000).toFixed(1);
  console.log(`[+${elapsed}s]`, ...args);
}

// ── Child expand code (template) ──────────────────────────────────────────────
const EXPAND_CODE = `
const _input = JSON.parse(fs.readFileSync(_inPath, 'utf8'));
TreeNode._nextId = _input.nextId;
const _out = [];
for (const rec of _input.nodes) {
  const cpState = new CPState(
    rec.vertices.map(v => [...v]),
    rec.creases.map(c => [...c]),
  );
  for (const op of allOps(cpState)) {
    for (const r of op(cpState)) {
      const { state, label = null } = (r instanceof CPState) ? { state: r } : r;
      _out.push({
        parentId: rec.id,
        id:       TreeNode._nextId++,
        depth:    rec.depth + 1,
        label,
        vertices: state.vertices,
        creases:  state.creases,
        canonKey: state.canonicalKey(),
      });
    }
  }
}
fs.writeFileSync(_outPath, JSON.stringify({ nextId: TreeNode._nextId, children: _out }));
`;

// ── Bootstrap: gen 0 + gen 1 ─────────────────────────────────────────────────
async function bootstrap() {
  log('Bootstrapping gen 0 + gen 1 ...');

  const res = runInChild(`
TreeNode._nextId = 0;
const rootState = makeUnitSquare();
const rootNode  = new TreeNode(rootState, { label: 'root' });
const seen      = new Set([rootState.canonicalKey()]);
const gen0 = [{
  id: rootNode.id, parentId: null, depth: 0, label: 'root',
  vertices: rootState.vertices, creases: rootState.creases,
}];
const gen1 = [];
for (const op of allOps(rootState)) {
  for (const r of op(rootState)) {
    const { state, label = null } = (r instanceof CPState) ? { state: r } : r;
    const ck = state.canonicalKey();
    if (!seen.has(ck)) {
      seen.add(ck);
      gen1.push({ id: TreeNode._nextId++, parentId: rootNode.id, depth: 1, label,
        vertices: state.vertices, creases: state.creases });
    }
  }
}
fs.writeFileSync(_outPath, JSON.stringify({
  nextId: TreeNode._nextId, gen0, gen1, seenKeys: [...seen],
}));
  `);

  if (!res) { log('Bootstrap failed'); process.exit(1); }

  fs.mkdirSync(genDir(0), { recursive: true });
  fs.writeFileSync(nodesPath(0), JSON.stringify(res.gen0[0]) + '\n');
  fs.writeFileSync(metaPath(0), JSON.stringify({ gen: 0, nodeCount: 1, nextId: 0 }));

  fs.mkdirSync(genDir(1), { recursive: true });
  const g1s = fs.createWriteStream(nodesPath(1));
  for (const n of res.gen1) g1s.write(JSON.stringify(n) + '\n');
  await new Promise(r => g1s.end(r));
  fs.writeFileSync(metaPath(1), JSON.stringify({
    gen: 1, nodeCount: res.gen1.length, nextId: res.nextId,
  }));

  const seen = new Set(res.seenKeys);
  saveSeenKeys(seen);
  log(`  gen0: 1 node, gen1: ${fmt(res.gen1.length)} nodes, seen: ${fmt(seen.size)} keys`);
  return { seen, nextId: res.nextId };
}

// ── Core: grow one generation with intra-gen checkpointing ───────────────────
async function growOneGen(fromGen, toGen, seen, nextId) {
  const srcPath  = nodesPath(fromGen);
  const dstDir   = genDir(toGen);
  const dstPath  = nodesPath(toGen);
  const progPath = progressPath(toGen);

  if (!fs.existsSync(srcPath)) {
    log(`ERROR: source not found: ${srcPath}`); process.exit(1);
  }

  // Count total source leaves upfront (for ETA/progress bar)
  log(`Counting source leaves in gen ${fromGen} ...`);
  let totalSourceLeaves = 0;
  await readNdjson(srcPath, () => totalSourceLeaves++);
  log(`  ${fmt(totalSourceLeaves)} source leaves to expand`);

  // Check for a partial run to resume
  fs.mkdirSync(dstDir, { recursive: true });
  let leavesProcessed = 0;
  let totalAdded      = 0;

  if (fs.existsSync(progPath)) {
    const prog = JSON.parse(fs.readFileSync(progPath, 'utf8'));
    leavesProcessed = prog.leavesProcessed;
    nextId          = prog.nextId;
    totalAdded      = prog.totalAdded || 0;
    log(`Resuming gen ${fromGen}→${toGen} from leaf ${fmt(leavesProcessed)}/${fmt(totalSourceLeaves)}`);
    log(`  nextId=${fmt(nextId)}  seen=${fmt(seen.size)}  already written=${fmt(totalAdded)}`);
  } else {
    // Fresh start for this gen's output file
    if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
    log(`Starting fresh gen ${fromGen}→${toGen}`);
  }

  const outStream = fs.createWriteStream(dstPath, { flags: 'a' }); // append mode

  let batch           = [];
  let linesSkipped    = 0;
  let totalCandidates = 0;
  let lastProgress    = Date.now();
  let lastLeafCount   = leavesProcessed;
  const genStart      = Date.now();

  // ── Save an intra-gen checkpoint ──────────────────────────────────────────
  const checkpoint = (forced = false) => {
    const prog = { leavesProcessed, nextId, totalAdded, totalCandidates };
    fs.writeFileSync(progPath + '.tmp', JSON.stringify(prog));
    fs.renameSync(progPath + '.tmp', progPath);
    saveSeenKeys(seen);
    if (forced) {
      const elapsedMs = Date.now() - genStart;
      const pct = totalSourceLeaves > 0
        ? ((leavesProcessed / totalSourceLeaves) * 100).toFixed(1)
        : '?';
      const eta = fmtETA(leavesProcessed, totalSourceLeaves, elapsedMs);
      log(
        `  CKPT  ${fmt(leavesProcessed)}/${fmt(totalSourceLeaves)} leaves (${pct}%)` +
        `  novel=${fmt(totalAdded)}  seen=${fmt(seen.size)}` +
        `  rate=${fmtRate(leavesProcessed - lastLeafCount, Date.now() - lastProgress)}` +
        `  ETA=${eta}  ${fmtMem()}`
      );
      lastProgress = Date.now();
      lastLeafCount = leavesProcessed;
    }
  };

  // ── Periodic time-based progress logger ───────────────────────────────────
  const progressTimer = setInterval(() => {
    const elapsedMs = Date.now() - genStart;
    const pct = totalSourceLeaves > 0
      ? ((leavesProcessed / totalSourceLeaves) * 100).toFixed(1)
      : '?';
    const eta = fmtETA(leavesProcessed, totalSourceLeaves, elapsedMs);
    log(
      `  ... ${fmt(leavesProcessed)}/${fmt(totalSourceLeaves)} (${pct}%)` +
      `  novel=${fmt(totalAdded)}  cands=${fmt(totalCandidates)}` +
      `  seen=${fmt(seen.size)}  ETA=${eta}  ${fmtMem()}`
    );
  }, PROGRESS_INTERVAL_MS);

  // ── Flush one batch to child process ──────────────────────────────────────
  const flushBatch = () => {
    if (batch.length === 0) return;
    const res = runInChild(EXPAND_CODE, { nextId, nodes: batch });
    if (res) {
      nextId = res.nextId;
      for (const child of res.children) {
        totalCandidates++;
        if (!seen.has(child.canonKey)) {
          seen.add(child.canonKey);
          totalAdded++;
          const { canonKey: _ck, ...rec } = child;
          outStream.write(JSON.stringify(rec) + '\n');
        }
      }
    }
    leavesProcessed += batch.length;
    batch = [];

    // Intra-gen checkpoint every N leaves
    if (leavesProcessed % CHECKPOINT_EVERY_N_LEAVES < BATCH_SIZE) {
      checkpoint(true);
    }
  };

  // ── Stream through source, skipping already-processed leaves ─────────────
  await readNdjson(srcPath, node => {
    if (linesSkipped < leavesProcessed) {
      linesSkipped++;
      return;
    }
    batch.push(node);
    if (batch.length >= BATCH_SIZE) flushBatch();
  });
  flushBatch(); // final partial batch

  clearInterval(progressTimer);
  await new Promise(res => outStream.end(res));

  // Final summary
  const totalMs = Date.now() - genStart;
  log(
    `  ✓ gen ${fromGen}→${toGen} complete` +
    `  source=${fmt(totalSourceLeaves)} leaves  novel=${fmt(totalAdded)}` +
    `  candidates=${fmt(totalCandidates)}  elapsed=${fmtSec(totalMs)}` +
    `  avg=${fmtRate(totalSourceLeaves, totalMs)}`
  );

  // Count output nodes, write meta, clean up progress file
  let nodeCount = 0;
  await readNdjson(dstPath, () => nodeCount++);
  fs.writeFileSync(metaPath(toGen), JSON.stringify({ gen: toGen, nodeCount, nextId }));
  if (fs.existsSync(progPath)) fs.unlinkSync(progPath);
  saveSeenKeys(seen);

  return { nextId, added: totalAdded };
}

// ── Command: grow ─────────────────────────────────────────────────────────────
async function cmdGrow(targetGen) {
  _logStart = Date.now();
  let curGen = currentGen();
  log(`Current gen: ${curGen}  →  target: ${targetGen}`);

  let seen, nextId;

  if (curGen < 1) {
    ({ seen, nextId } = await bootstrap());
    curGen = 1;
  } else {
    seen   = loadSeenKeys();
    nextId = (readMeta(curGen) || {}).nextId || 0;
  }

  for (let g = curGen; g < targetGen; g++) {
    log(`\n${'─'.repeat(60)}`);
    log(`Growing gen ${g} → ${g+1}  seen=${fmt(seen.size)}  ${fmtMem()}`);
    const { nextId: newId } = await growOneGen(g, g+1, seen, nextId);
    nextId = newId;
  }

  log('\n✓ All done.');
}

// ── Command: status ───────────────────────────────────────────────────────────
function cmdStatus() {
  const cur = currentGen();
  if (cur < 0) { console.log('No checkpoints. Run:  node grow2.js grow [n]'); return; }

  console.log(`Checkpoints: ${CKPT_DIR}`);
  let totalNodes = 0;
  for (let g = 0; g <= cur; g++) {
    const m = readMeta(g);
    if (!m) continue;
    totalNodes += m.nodeCount;
    const ndjsonSize = fs.existsSync(nodesPath(g))
      ? fmtBytes(fs.statSync(nodesPath(g)).size) : '?';
    console.log(`  gen ${g}: ${fmt(m.nodeCount).padStart(10)} leaf nodes   ndjson=${ndjsonSize}`);
  }

  // Check for a partial generation in progress
  const partialGen = cur + 1;
  const progPath   = progressPath(partialGen);
  if (fs.existsSync(progPath)) {
    const prog = JSON.parse(fs.readFileSync(progPath, 'utf8'));
    console.log(`  gen ${partialGen}: IN PROGRESS — ${fmt(prog.leavesProcessed)} leaves done, ${fmt(prog.totalAdded)} novel nodes so far`);
  }

  if (fs.existsSync(SEEN_PATH)) {
    const sz  = fmtBytes(fs.statSync(SEEN_PATH).size);
    const arr = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'));
    console.log(`  seen_keys: ${fmt(arr.length)} unique states   file=${sz}`);
  }
  console.log(`  total leaf nodes across all complete gens: ${fmt(totalNodes)}`);
}

// ── Z[√2] math inline (mirrors rbb2.js, for use in parent process) ────────────
function gcd(a, b) { a=Math.abs(a); b=Math.abs(b); while(b){[a,b]=[b,a%b];} return a||1; }
const _Z2 = {
  reduce([p,q,d]) {
    if (d<0){p=-p;q=-q;d=-d;}
    if (p===0&&q===0) return [0,0,1];
    const g=gcd(gcd(Math.abs(p),Math.abs(q)),d);
    return [p/g,q/g,d/g];
  },
  eq([p,q,d],[r,s,e]) { return p*e===r*d && q*e===s*d; },
  sub([p,q,d],[r,s,e]) {
    const l=d*e/gcd(d,e);
    return _Z2.reduce([p*(l/d)-r*(l/e), q*(l/d)-s*(l/e), l]);
  },
};
const _Vx = v => [v[0],v[1],v[2]];
const _Vy = v => [v[3],v[4],v[5]];

// Compute all 8 D4 transforms of a target vertex [p1,q1,d1,p2,q2,d2]
// Returns array of 8 reduced vertices.
function d4Transforms(v) {
  const x=_Vx(v), y=_Vy(v);
  const one=[1,0,1];
  const ox=_Z2.reduce(_Z2.sub(one,x)), oy=_Z2.reduce(_Z2.sub(one,y));
  const rx=_Z2.reduce(x), ry=_Z2.reduce(y);
  return [
    [...rx,...ry], [...oy,...rx], [...ox,...oy], [...ry,...ox],
    [...rx,...oy], [...ox,...ry], [...ry,...rx], [...oy,...ox],
  ];
}
const D4_NAMES = ['r0','r90','r180','r270','fx','fy','fd1','fd2'];

// Test whether a node's vertex list contains any of the 8 transform targets.
function nodeMatchesAny(node, transforms) {
  for (let ti = 0; ti < transforms.length; ti++) {
    const t = transforms[ti];
    for (const v of node.vertices) {
      const rv = [..._Z2.reduce(_Vx(v)), ..._Z2.reduce(_Vy(v))];
      if (_Z2.eq(_Vx(rv),_Vx(t)) && _Z2.eq(_Vy(rv),_Vy(t))) return ti;
    }
  }
  return -1;
}

// ── Command: search ───────────────────────────────────────────────────────────
// Strategy:
//   1. Compute the 8 D4 transforms of the target vertex inline (no child).
//   2. Stream through each gen's ndjson looking for a match — O(1) RAM per node.
//   3. On hit, record the matched node and its parentId chain (≤7 IDs).
//   4. Walk back up through earlier gens with targeted id-lookup scans to build path.
async function cmdSearch(ax, bx, cx, ay, by, cy) {
  _logStart = Date.now();
  const cur = currentGen();
  if (cur < 0) { console.error('No checkpoints. Run grow first.'); process.exit(1); }

  log(`Searching gen 0..${cur} for (${ax}+${bx}√2)/${cx}, (${ay}+${by}√2)/${cy}`);

  const target     = [..._Z2.reduce([ax,bx,cx]), ..._Z2.reduce([ay,by,cy])];
  const transforms = d4Transforms(target);
  log(`  D4 transforms computed. Streaming ndjson files...`);

  // ── Pass 1: stream all gens, stop at first match ───────────────────────────
  let matchedNode = null;
  let matchedTi   = -1;

  outer:
  for (let g = 0; g <= cur; g++) { 
    const p = nodesPath(g);
    if (!fs.existsSync(p)) continue;
    let scanned = 0;
    await readNdjson(p, node => {
      if (matchedNode) return;
      scanned++;
      const ti = nodeMatchesAny(node, transforms);
      if (ti >= 0) { matchedNode = node; matchedTi = ti; }
    });
    log(`  gen ${g}: scanned ${fmt(scanned)} nodes  ${fmtMem()}`);
    if (matchedNode) break;
  }

  if (!matchedNode) {
    log('Vertex not found in any generation. Try growing more.');
    return;
  }

  log(`  Hit: node #${matchedNode.id} depth=${matchedNode.depth} label="${matchedNode.label}" transform=${D4_NAMES[matchedTi]}`);

  // ── Pass 2: collect the ancestor id chain ─────────────────────────────────
  // Walk parentId links — depth is at most 7 so this is trivial.
  const ancestorIds = [];
  let cur2 = matchedNode;
  while (cur2) {
    ancestorIds.unshift(cur2.id);
    if (cur2.parentId == null) break;
    // We need to look up the parent node. It lives in gen (depth-1).
    // Scan that gen's file for the specific id.
    const parentDepth = cur2.depth - 1;
    const parentId    = cur2.parentId;
    let parentNode    = null;
    const pFile       = nodesPath(parentDepth);
    if (fs.existsSync(pFile)) {
      await readNdjson(pFile, n => { if (n.id === parentId) parentNode = n; });
    }
    if (!parentNode) {
      log(`  WARNING: could not find parent id=${parentId} in gen ${parentDepth}`);
      break;
    }
    cur2 = parentNode;
  }

  // Build ordered path by scanning each gen file once for the needed ids
  const neededIds = new Set(ancestorIds);
  const byId      = new Map();
  for (let g = 0; g <= matchedNode.depth; g++) {
    const p = nodesPath(g);
    if (!fs.existsSync(p)) continue;
    await readNdjson(p, n => { if (neededIds.has(n.id)) byId.set(n.id, n); });
  }
  // Also include the matched node itself
  byId.set(matchedNode.id, matchedNode);

  const pathNodes = ancestorIds.map(id => byId.get(id)).filter(Boolean);

  // transformIdx is stored so the visualizer can apply the D4 transform.

  const result = {
    found:         true,
    transformIdx:  matchedTi,
    transformName: D4_NAMES[matchedTi],
    targetVertex:  target,
    matchedNode,
    path:          pathNodes,
  };

  const outPath = path.join(HERE, 'search_path.json');
  fs.writeFileSync(outPath, JSON.stringify(result));

  log(`\nFound!`);
  log(`  Node #${matchedNode.id}  depth=${matchedNode.depth}  transform=${D4_NAMES[matchedTi]}`);
  log(`  Path: ${pathNodes.map(n => `#${n.id}[${n.label}]`).join(' → ')}`);
  log(`  Saved → search_path.json`);
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────
const [,, cmd, ...args] = process.argv;

if (cmd === 'grow') {
  const cur    = currentGen();
  // If a partial gen is in progress, default target is that gen; else current+1
  const inProg = fs.existsSync(progressPath(cur + 1)) ? cur + 1 : cur + 1;
  const target = parseInt(args[0] ?? String(inProg), 10);
  cmdGrow(target).catch(e => { console.error(e); process.exit(1); });

} else if (cmd === 'status') {
  cmdStatus();

} else if (cmd === 'search') {
  if (args.length < 6) { console.error('Usage: node grow2.js search ax bx cx ay by cy'); process.exit(1); }
  cmdSearch(...args.map(Number)).catch(e => { console.error(e); process.exit(1); });

} else {
  console.log('Usage:');
  console.log('  node --max-old-space-size=4096 grow2.js grow [targetGen]');
  console.log('  node grow2.js status');
  console.log('  node grow2.js search ax bx cx ay by cy');
}