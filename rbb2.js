// =============================================================================
// Z[√2] over ℚ  —  scalars stored as [p, q, d]  meaning  p/d + (q/d)·√2
// d is always a positive integer; p, q are integers.
// Vertices are [p1,q1,d1, p2,q2,d2]  meaning  (p1/d1 + q1/d1·√2,  p2/d2 + q2/d2·√2)
// =============================================================================

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

function lcm(a, b) { return Math.abs(a * b) / gcd(a, b); }

const Z2 = {
  // Reduce [p,q,d] to canonical form: d>0, gcd(|p|,|q|,d)=1
  reduce([p, q, d]) {
    if (d < 0) { p=-p; q=-q; d=-d; }
    if (p === 0 && q === 0) return [0, 0, 1];
    const g = gcd(gcd(Math.abs(p), Math.abs(q)), d);
    return [p/g, q/g, d/g];
  },

  zero: () => [0, 0, 1],
  one:  () => [1, 0, 1],

  eq([p,q,d], [r,s,e]) {
    // cross-multiply to avoid reducing first
    return p*e === r*d && q*e === s*d;
  },

  isZero([p,q,d]) { return p === 0 && q === 0; },

  add([p,q,d], [r,s,e]) {
    const l = lcm(d, e);
    return Z2.reduce([p*(l/d) + r*(l/e),  q*(l/d) + s*(l/e),  l]);
  },

  sub([p,q,d], [r,s,e]) {
    const l = lcm(d, e);
    return Z2.reduce([p*(l/d) - r*(l/e),  q*(l/d) - s*(l/e),  l]);
  },

  // (p/d + q/d·√2)(r/e + s/e·√2) = (pr+2qs)/(de) + (ps+qr)/(de)·√2
  mul([p,q,d], [r,s,e]) {
    return Z2.reduce([p*r + 2*q*s,  p*s + q*r,  d*e]);
  },

  neg([p,q,d]) { return [-p, -q, d]; },

  // (p/d + q/d·√2) / (r/e + s/e·√2)
  // multiply num and denom by conjugate (r/e - s/e·√2):
  // norm = (r²-2s²)/e²   (a rational)
  // result = [(pr-2qs)·e/d·(e/(r²-2s²)),  (qr-ps)·e/d·(e/(r²-2s²))]  ·√2
  // Stays exact in ℚ, so always succeeds unless norm=0 (parallel lines).
  div([p,q,d], [r,s,e]) {
    const normNum = r*r - 2*s*s;   // norm numerator  (times e²)
    if (normNum === 0) return null; // zero divisor
    // result_p/result_d = (p*r - 2*q*s) / (d * normNum/e)  ... simplify:
    // num·√2 part: (q*r - p*s)
    // common denom factor: d * normNum,  but we had e in both num & denom
    // Full derivation:
    //   num = (p + q√2)/d  ÷  (r + s√2)/e
    //       = (p + q√2)·e / (d·(r + s√2))
    //       = (p + q√2)·e·(r - s√2) / (d·(r²-2s²))
    //       = [(pr - 2qs)·e + (qr - ps)·e·√2] / [d·(r²-2s²)]
    const newP = (p*r - 2*q*s) * e;
    const newQ = (q*r - p*s)   * e;
    const newD = d * normNum;
    return Z2.reduce([newP, newQ, newD]);
  },

  toFloat([p,q,d]) { return (p + q * Math.SQRT2) / d; },

  toString([p,q,d]) {
    const a = p/d, b = q/d;  // just for display
    const aStr = Number.isInteger(a) ? `${a}` : `${p}/${d}`;
    const bStr = Number.isInteger(b) ? (Math.abs(b)===1?'':`${Math.abs(b)}`) : `${Math.abs(q)}/${d}`;
    if (q === 0) return aStr;
    if (p === 0) return `${q<0?'-':''}${bStr}√2`;
    return `${aStr}${q<0?'-':'+'}${bStr}√2`;
  },
};

// =============================================================================
// Vertex:  [p1,q1,d1, p2,q2,d2]
// =============================================================================

const Vertex = {
  x: ([p1,q1,d1])        => [p1,q1,d1],
  y: ([,,,p2,q2,d2])     => [p2,q2,d2],
  make: (x, y)           => [...x, ...y],

  eq: ([p1,q1,d1,p2,q2,d2], [r1,s1,e1,r2,s2,e2]) =>
    Z2.eq([p1,q1,d1],[r1,s1,e1]) && Z2.eq([p2,q2,d2],[r2,s2,e2]),

  // Canonical key: reduce each coordinate, then stringify
  key(v) {
    const [p1,q1,d1,p2,q2,d2] = v;
    const [a,b,c] = Z2.reduce([p1,q1,d1]);
    const [d,e,f] = Z2.reduce([p2,q2,d2]);
    return `${a},${b},${c};${d},${e},${f}`;
  },

  toFloat: ([p1,q1,d1,p2,q2,d2]) => [Z2.toFloat([p1,q1,d1]), Z2.toFloat([p2,q2,d2])],
  toString: ([p1,q1,d1,p2,q2,d2]) => `(${Z2.toString([p1,q1,d1])}, ${Z2.toString([p2,q2,d2])})`,
};

// =============================================================================
// Line:  { A, B, C }  with A,B,C in Z[√2]/ℚ,  meaning  A·x + B·y + C = 0
// =============================================================================

const Line = {
  through(v1, v2) {
    const x1=Vertex.x(v1), y1=Vertex.y(v1);
    const x2=Vertex.x(v2), y2=Vertex.y(v2);
    return {
      A: Z2.sub(y2, y1),
      B: Z2.sub(x1, x2),
      C: Z2.sub(Z2.mul(x2,y1), Z2.mul(x1,y2)),
    };
  },

  horizontal: (k) => ({ A: Z2.zero(), B: Z2.one(), C: Z2.neg(k) }),
  vertical:   (k) => ({ A: Z2.one(),  B: Z2.zero(), C: Z2.neg(k) }),

  intersect(l1, l2) {
    const det = Z2.sub(Z2.mul(l1.A,l2.B), Z2.mul(l2.A,l1.B));
    if (Z2.isZero(det)) return null;
    const xN = Z2.sub(Z2.mul(Z2.neg(l1.C),l2.B), Z2.mul(Z2.neg(l2.C),l1.B));
    const yN = Z2.sub(Z2.mul(l1.A,Z2.neg(l2.C)), Z2.mul(l2.A,Z2.neg(l1.C)));
    const x  = Z2.div(xN, det);
    const y  = Z2.div(yN, det);
    if (!x || !y) return null;
    return Vertex.make(x, y);
  },

  toString: (l) => `${Z2.toString(l.A)}·x + ${Z2.toString(l.B)}·y + ${Z2.toString(l.C)} = 0`,
};

// =============================================================================
// Unit square boundary
// =============================================================================

const BOUNDARY = [
  Line.horizontal([0,0,1]),   // y = 0
  Line.horizontal([1,0,1]),   // y = 1
  Line.vertical([0,0,1]),     // x = 0
  Line.vertical([1,0,1]),     // x = 1
];

function inUnit(f) { return f >= -1e-10 && f <= 1+1e-10; }

function clipToSquare(line) {
  const pts = [];
  for (const edge of BOUNDARY) {
    const v = Line.intersect(line, edge);
    if (!v) continue;
    const [fx, fy] = Vertex.toFloat(v);
    if (inUnit(fx) && inUnit(fy) && !pts.some(p => Vertex.eq(p,v)))
      pts.push(v);
  }
  return pts.length >= 2 ? [pts[0], pts[1]] : null;
}

// =============================================================================
// Shared core: apply a line to a CPState
// Intersects against all existing creases, interns intersection vertices,
// then adds the new crease between boundary endpoints.
// =============================================================================

function applyLineToCPState(cpState, line, endpoints, label) {
  if (!endpoints) return null;
  const [ep0, ep1] = endpoints;
  const [ex,ey]    = Vertex.toFloat(ep0);
  const [fx,fy]    = Vertex.toFloat(ep1);

  const next = cpState.clone();

  for (const [ci,cj] of cpState.creases) {
    const cv1 = cpState.vertices[ci];
    const cv2 = cpState.vertices[cj];
    const pt  = Line.intersect(line, Line.through(cv1, cv2));
    if (!pt) continue;

    const [px,py]   = Vertex.toFloat(pt);
    const [c1x,c1y] = Vertex.toFloat(cv1);
    const [c2x,c2y] = Vertex.toFloat(cv2);

    const onCrease = Math.min(c1x,c2x)-1e-10 <= px && px <= Math.max(c1x,c2x)+1e-10 &&
                     Math.min(c1y,c2y)-1e-10 <= py && py <= Math.max(c1y,c2y)+1e-10;
    const onNew    = Math.min(ex,fx)-1e-10    <= px && px <= Math.max(ex,fx)+1e-10 &&
                     Math.min(ey,fy)-1e-10    <= py && py <= Math.max(ey,fy)+1e-10;

    if (onCrease && onNew) next.internVertex(pt);
  }

  const a = next.internVertex(ep0);
  const b = next.internVertex(ep1);
  next.internCrease(a, b);
  return { state: next, label };
}

// =============================================================================
// CPState
// =============================================================================

class CPState {
  constructor(vertices=[], creases=[]) {
    this.vertices = vertices;
    this.creases  = creases;
    // Fast vertex lookup: canonical key → index
    this._vmap = new Map(vertices.map((v,i) => [Vertex.key(v), i]));
  }

  clone() {
    const s = new CPState(
      this.vertices.map(v => [...v]),
      this.creases.map(c => [...c]),
    );
    s._vmap = new Map(this._vmap);
    return s;
  }

  internVertex(v) {
    // Normalize before lookup so e.g. [0,0,2] and [0,0,1] hit the same key
    const norm = [...Z2.reduce(Vertex.x(v)), ...Z2.reduce(Vertex.y(v))];
    const k = Vertex.key(norm);
    if (this._vmap.has(k)) return this._vmap.get(k);
    const idx = this.vertices.length;
    this.vertices.push(norm);
    this._vmap.set(k, idx);
    return idx;
  }

  internCrease(i, j) {
    if (i === j) return;
    if (!this.creases.some(([a,b]) => (a===i&&b===j)||(a===j&&b===i)))
      this.creases.push([i,j]);
  }

  // D4 symmetry group: 8 transforms of a vertex in the unit square.
  // Returns all 8 transformed vertices as [p1,q1,d1,p2,q2,d2] arrays.
  static _d4(v) {
    const x = Vertex.x(v), y = Vertex.y(v);
    const one = [1,0,1];
    const ox = Z2.sub(one, x), oy = Z2.sub(one, y);  // 1-x, 1-y
    return [
      [...x,  ...y ],   // r0:   (x,   y)
      [...oy, ...x ],   // r90:  (1-y, x)
      [...ox, ...oy],   // r180: (1-x, 1-y)
      [...y,  ...ox],   // r270: (y,   1-x)
      [...x,  ...oy],   // fx:   (x,   1-y)
      [...ox, ...y ],   // fy:   (1-x, y)
      [...y,  ...x ],   // fd1:  (y,   x)
      [...oy, ...ox],   // fd2:  (1-y, 1-x)
    ];
  }

  // Key for one specific D4 transform index (0-7).
  _keyForTransform(ti) {
    const tvertKeys = this.vertices.map(v => {
      const tv = CPState._d4(v)[ti];
      const norm = [...Z2.reduce(Vertex.x(tv)), ...Z2.reduce(Vertex.y(tv))];
      return Vertex.key(norm);
    });
    const order = tvertKeys
      .map((k, i) => [k, i])
      .sort((a,b) => a[0]<b[0]?-1:a[0]>b[0]?1:0);
    const remap = new Array(this.vertices.length);
    order.forEach(([,oldIdx], newIdx) => remap[oldIdx] = newIdx);
    const cs = this.creases
      .map(([a,b]) => { const x=remap[a],y=remap[b]; return x<y?x+'-'+y:y+'-'+x; })
      .sort()
      .join('|');
    return order.map(([k])=>k).join('||') + '::::' + cs;
  }

  // Canonical key = lex-minimum over all 8 D4 transforms.
  // Two D4-equivalent states share this key and are deduplicated.
  canonicalKey() {
    let best = null;
    for (let ti = 0; ti < 8; ti++) {
      const k = this._keyForTransform(ti);
      if (best === null || k < best) best = k;
    }
    return best;
  }

  toString() {
    const vs = this.vertices.map((v,i)=>`  ${i}: ${Vertex.toString(v)}`).join('\n');
    const cs = this.creases.map(([i,j])=>`  ${i}─${j}`).join('\n');
    return `CPState {\n vertices:\n${vs||'  (none)'}\n creases:\n${cs||'  (none)'}\n}`;
  }
}

// =============================================================================
// TreeNode
// =============================================================================

class TreeNode {
  constructor(cpState, { label=null, parent=null }={}) {
    this.id       = TreeNode._nextId++;
    this.cpState  = cpState;
    this.label    = label;
    this.parent   = parent;
    this.children = [];
    this.depth    = parent ? parent.depth + 1 : 0;
  }
  get isLeaf() { return this.children.length === 0; }
  get isRoot()  { return this.parent === null; }
}
TreeNode._nextId = 0;

// =============================================================================
// CPTree
// =============================================================================

class CPTree {
  constructor(rootState, rootLabel='root') {
    this.root  = new TreeNode(rootState, { label: rootLabel });
    this._seen = new Map();
    this._seen.set(this.root.cpState.canonicalKey(), this.root);
  }

  // Returns true if this state is novel and the node was registered
  _register(node) {
    const k = node.cpState.canonicalKey();
    if (this._seen.has(k)) return false;
    this._seen.set(k, node);
    return true;
  }

  // Apply fn to one node. fn(cpState) → [{state, label}, ...]
  grow(node, fn) {
    const added = [];
    for (const r of fn(node.cpState)) {
      const { state, label=null } = r instanceof CPState ? { state:r } : r;
      const child = new TreeNode(state, { label, parent: node });
      if (this._register(child)) {
        node.children.push(child);
        added.push(child);
      }
    }
    return added;
  }

  // Apply fn to every current leaf — your main growth primitive
  growLeaves(fn) {
    const leaves = this.leaves;   // snapshot before we add children
    const added  = [];
    for (const leaf of leaves) added.push(...this.grow(leaf, fn));
    return added;
  }

  // Apply fn to every node in BFS order
  growBFS(fn, { filter=()=>true, maxDepth=Infinity }={}) {
    const queue = [this.root], added = [];
    while (queue.length) {
      const node = queue.shift();
      if (node.depth < maxDepth && filter(node)) added.push(...this.grow(node, fn));
      queue.push(...node.children);
    }
    return added;
  }

  // Apply fn to every node in DFS order
  growDFS(fn, { filter=()=>true, maxDepth=Infinity }={}) {
    const added = [];
    const visit = node => {
      if (node.depth < maxDepth && filter(node)) added.push(...this.grow(node, fn));
      node.children.forEach(visit);
    };
    visit(this.root);
    return added;
  }

  forEach(cb) {
    const q = [this.root];
    while (q.length) { const n=q.shift(); cb(n); q.push(...n.children); }
  }

  find(pred) { const out=[]; this.forEach(n=>{if(pred(n))out.push(n);}); return out; }

  get leaves()   { return this.find(n => n.isLeaf); }
  get size()     { let c=0; this.forEach(()=>c++); return c; }
  get maxDepth() { let d=0; this.forEach(n=>{if(n.depth>d)d=n.depth;}); return d; }

  print() {
    this.forEach(node => {
      const indent = '  '.repeat(node.depth);
      const tag    = node.label ? ` [${node.label}]` : '';
      const {vertices:vs, creases:cs} = node.cpState;
      console.log(`${indent}#${node.id}${tag}  (${vs.length}v, ${cs.length}c)`);
    });
  }
}

// =============================================================================
// Operations  —  each returns  (cpState) => [{state, label}]
// =============================================================================

// Crease through vertices vi and vj, extended to square boundary.
// Intersections with existing creases become new vertices.
function opCreaseThroughVertices(vi, vj) {
  return cpState => {
    const v1=cpState.vertices[vi], v2=cpState.vertices[vj];
    if (!v1||!v2) return [];
    const line = Line.through(v1, v2);
    const r    = applyLineToCPState(cpState, line, clipToSquare(line), `crease ${vi}-${vj}`);
    return r ? [r] : [];
  };
}

// Axis-parallel line through vertex vi.
// axis 'x' -> vertical line (constant x),  axis 'y' -> horizontal line (constant y)
function opParallelToEdge(vi, axis) {
  return cpState => {
    const v = cpState.vertices[vi];
    if (!v) return [];
    const k    = axis==='x' ? Vertex.x(v) : Vertex.y(v);
    const line = axis==='x' ? Line.vertical(k) : Line.horizontal(k);
    const r    = applyLineToCPState(cpState, line, clipToSquare(line),
                   `${axis==='x'?'vertical':'horizontal'} through v${vi}`);
    return r ? [r] : [];
  };
}

// Self-contained bisector: scans existing creases for parallel axis-aligned pairs,
// returns one child per unique midpoint (deduplication handles overlap).
// A crease is vertical if both endpoints share the same reduced x coordinate,
// horizontal if both share the same reduced y coordinate.
function opBisector() {
  return cpState => {
    const results = [];

    // Collect vertical and horizontal crease constants from existing creases
    const verticals   = new Map(); // x-key -> Z2 scalar [p,q,d]
    const horizontals = new Map(); // y-key -> Z2 scalar [p,q,d]

    for (const [ci, cj] of cpState.creases) {
      const v1 = cpState.vertices[ci], v2 = cpState.vertices[cj];
      const x1 = Z2.reduce(Vertex.x(v1)), x2 = Z2.reduce(Vertex.x(v2));
      const y1 = Z2.reduce(Vertex.y(v1)), y2 = Z2.reduce(Vertex.y(v2));
      const xk1 = x1.join(','), xk2 = x2.join(',');
      const yk1 = y1.join(','), yk2 = y2.join(',');

      if (xk1 === xk2) verticals.set(xk1, x1);    // vertical crease at x=x1
      if (yk1 === yk2) horizontals.set(yk1, y1);   // horizontal crease at y=y1
    }

    const vVals = [...verticals.values()];
    const hVals = [...horizontals.values()];

    // Every pair of vertical creases -> bisector vertical
    for (let i = 0; i < vVals.length; i++) {
      for (let j = i+1; j < vVals.length; j++) {
        const mid  = Z2.div(Z2.add(vVals[i], vVals[j]), [2,0,1]);
        if (!mid) continue;
        const line = Line.vertical(mid);
        const r    = applyLineToCPState(cpState, line, clipToSquare(line),
                       `bisect-v ${Z2.toString(vVals[i])},${Z2.toString(vVals[j])}`);
        if (r) results.push(r);
      }
    }

    // Every pair of horizontal creases -> bisector horizontal
    for (let i = 0; i < hVals.length; i++) {
      for (let j = i+1; j < hVals.length; j++) {
        const mid  = Z2.div(Z2.add(hVals[i], hVals[j]), [2,0,1]);
        if (!mid) continue;
        const line = Line.horizontal(mid);
        const r    = applyLineToCPState(cpState, line, clipToSquare(line),
                       `bisect-h ${Z2.toString(hVals[i])},${Z2.toString(hVals[j])}`);
        if (r) results.push(r);
      }
    }

    return results;
  };
}

// Angle bisectors of the 45-degree creases at diagonal corners.
// For each diagonal present, returns up to 4 bisector children PLUS
// one passthrough child (unchanged state, label 'no-bisector') so that
// branch stays alive in the tree even if no bisector is applied.
// Returns [] if neither diagonal is present (op is not applicable).
function opAngleBisectors() {
  const MAIN_LINES = [
    { from: [0,0,1, 0,0,1], to: [1,0,1, -1,1,1], label: 'bisect-main-A' }, // (0,0)->(1, rt2-1)
    { from: [0,0,1, 0,0,1], to: [-1,1,1, 1,0,1], label: 'bisect-main-B' }, // (0,0)->(rt2-1, 1)
    { from: [1,0,1, 1,0,1], to: [2,-1,1, 0,0,1], label: 'bisect-main-C' }, // (1,1)->(2-rt2, 0)
    { from: [1,0,1, 1,0,1], to: [0,0,1, 2,-1,1], label: 'bisect-main-D' }, // (1,1)->(0, 2-rt2)
  ];
  const ANTI_LINES = [
    { from: [1,0,1, 0,0,1], to: [0,0,1, -1,1,1], label: 'bisect-anti-A' }, // (1,0)->(0, rt2-1)
    { from: [1,0,1, 0,0,1], to: [2,-1,1, 1,0,1], label: 'bisect-anti-B' }, // (1,0)->(2-rt2, 1)
    { from: [0,0,1, 1,0,1], to: [-1,1,1, 0,0,1], label: 'bisect-anti-C' }, // (0,1)->(rt2-1, 0)
    { from: [0,0,1, 1,0,1], to: [1,0,1, 2,-1,1], label: 'bisect-anti-D' }, // (0,1)->(1, 2-rt2)
  ];

  function hasCreaseBetween(cpState, va, vb) {
    const ia = cpState.vertices.findIndex(v => Vertex.eq(v, va));
    const ib = cpState.vertices.findIndex(v => Vertex.eq(v, vb));
    if (ia===-1||ib===-1) return false;
    return cpState.creases.some(([a,b]) => (a===ia&&b===ib)||(a===ib&&b===ia));
  }

  // Check whether all bisectors for a given set are already present
  function allPresent(cpState, lines) {
    return lines.every(({ from, to }) => hasCreaseBetween(cpState, from, to));
  }

  return cpState => {
    const mainPresent = hasCreaseBetween(cpState, [0,0,1,0,0,1], [1,0,1,1,0,1]);
    const antiPresent = hasCreaseBetween(cpState, [1,0,1,0,0,1], [0,0,1,1,0,1]);
    if (!mainPresent && !antiPresent) return [];

    const results = [];

    const candidates = [
      ...(mainPresent ? MAIN_LINES : []),
      ...(antiPresent ? ANTI_LINES : []),
    ];

    for (const { from, to, label } of candidates) {
      const line = Line.through(from, to);
      const r    = applyLineToCPState(cpState, line, clipToSquare(line), label);
      if (r) results.push(r);
    }

    // Passthrough: keep this branch alive without adding any bisector.
    // Only meaningful if there are actual bisectors we could have added;
    // deduplication will discard it if this state is already in the tree.
    const passthroughNeeded =
      (mainPresent && !allPresent(cpState, MAIN_LINES)) ||
      (antiPresent && !allPresent(cpState, ANTI_LINES));
    if (passthroughNeeded) {
      results.push({ state: cpState.clone(), label: 'no-bisector' });
    }

    return results;
  };
}

// =============================================================================
// Bootstrap
// =============================================================================

function makeUnitSquare() {
  //        x-----------x  vertices: (0,0),(1,0),(1,1),(0,1)  in [p,q,d] form
  const V = (p1,q1,d1, p2,q2,d2) => [p1,q1,d1, p2,q2,d2];
  return new CPState(
    [ V(0,0,1, 0,0,1),   // 0: (0, 0)
      V(1,0,1, 0,0,1),   // 1: (1, 0)
      V(1,0,1, 1,0,1),   // 2: (1, 1)
      V(0,0,1, 1,0,1) ], // 3: (0, 1)
    [[0,1],[1,2],[2,3],[3,0]],
  );
}

// =============================================================================
// allOps: generate every possible operation on a given cpState
//
// Returns an array of op functions, one per valid (operation x parameterization).
// Calling each fn(cpState) yields [{state, label}] for that specific move.
//
//   opCreaseThroughVertices — every ordered pair (i < j) of distinct vertices
//   opParallelToEdge        — every vertex x both axes
//   opBisector              — self-contained, one call covers all pairs
//   opAngleBisectors        — self-contained, one call covers both diagonals
// =============================================================================

function allOps(cpState) {
  const ops  = [];
  const n    = cpState.vertices.length;

  // Every pair of vertices
  for (let i = 0; i < n; i++)
    for (let j = i+1; j < n; j++)
      ops.push(opCreaseThroughVertices(i, j));

  // Every vertex x both axes
  for (let i = 0; i < n; i++) {
    ops.push(opParallelToEdge(i, 'x'));
    ops.push(opParallelToEdge(i, 'y'));
  }

  // Self-contained ops (each is a single fn covering all parameterizations)
  ops.push(opBisector());
  ops.push(opAngleBisectors());

  return ops;
}

// =============================================================================
// growGeneration: apply every possible op to every current leaf.
// Returns the newly added nodes.
// =============================================================================

function growGeneration(tree) {
  const leaves = tree.leaves;   // snapshot before growth
  const added  = [];

  for (const leaf of leaves) {
    for (const op of allOps(leaf.cpState)) {
      added.push(...tree.grow(leaf, op));
    }
  }

  return added;
}

// =============================================================================
// Bootstrap + two-generation growth

const tree = new CPTree(makeUnitSquare(), 'root');
console.log('Generation 0:', tree.size, 'nodes,', tree.leaves.length, 'leaves');
const gen1 = growGeneration(tree);
console.log('Generation 1:', tree.size, 'nodes,', tree.leaves.length, 'leaves,', gen1.length, 'added');
const gen2 = growGeneration(tree);
console.log('Generation 2:', tree.size, 'nodes,', tree.leaves.length, 'leaves,', gen2.length, 'added');
tree.print();