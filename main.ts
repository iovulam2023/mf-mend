// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  new: string;
}
type Edit = (tree: Tree, moves: Move[]) => void;

/** A file as lines (SPEC.md section 3): its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Matching lines (SPEC.md section 5): the three tiers. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(fileLines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface Ent {
  text: string;
  ctx: boolean;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** The lines a match writes: context lines are the file's own; at tier 2 the rest are re-indented (section 5). */
function produce(fileLines: string[], pos: number, o: Ent[], n: Ent[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((e, j) => {
    if (e.ctx) oCtx.push(j);
  });
  let c = 0;
  const f = leadWs(fileLines[pos]!);
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + oCtx[c++]!]!;
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) return f + e.text.slice(p.length);
    return e.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC.md section 6). */
interface UBody {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  emptyLine: boolean;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  createFlag: boolean;
  delFlag: boolean;
  hunks: UHunk[];
}

function gitPaths(line: string, no: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const idx = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (idx < 0) throw new Exit2(`error: parse ${no}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${no}`);
  return [x, y];
}

function hdrPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Whether a `\` line follows the body's last context or `+` line. */
function bsAfterLastCtxNew(body: UBody[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') return body[k + 1]?.kind === 'bs';
  }
  return false;
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renameOld !== undefined ? s.renameOld : s.gitOld;
  const newP = s.hdrNew !== undefined ? s.hdrNew : s.renameNew !== undefined ? s.renameNew : s.gitNew;
  return (tree, moves) => {
    if (s.createFlag || oldP === null) {
      const p = newP as string;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '/dev/null');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const flat: UBody[] = [];
      for (const h of s.hunks) flat.push(...h.body);
      const plus: string[] = [];
      let lastBs = false;
      flat.forEach((b, idx) => {
        if (b.kind === 'new') {
          plus.push(b.text);
          lastBs = flat[idx + 1]?.kind === 'bs';
        }
      });
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (s.delFlag || newP === null) {
      const p = oldP as string;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '/dev/null');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const po = oldP as string;
    const pn = newP as string;
    if (!safe(po)) throw new Fail('unsafe', po);
    if (pn !== po && !safe(pn)) throw new Fail('unsafe', pn);
    const before = tree.get(po);
    if (before === null) throw new Fail('missing', po);
    if (pn !== po && tree.get(pn) !== null) throw new Fail('exists', pn);
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const o: Ent[] = [];
      const n: Ent[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else if (b.kind === 'new') n.push({ text: b.text, ctx: false });
      }
      if (o.length === 0) {
        const pos = Math.min(h.a + d, f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines.splice(pos, 0, ...n.map((e) => e.text));
        if (atEnd) f.final = !bsAfterLastCtxNew(h.body);
        d += n.length;
        continue;
      }
      const found = findTier(f.lines, o.map((e) => e.text), strict, 0);
      if (found === null) throw new Fail('no-match', po);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const cand of found.occ) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const produced = produce(f.lines, pos, o, n, found.tier);
      const toEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...produced);
      if (toEnd) f.final = !bsAfterLastCtxNew(h.body);
      d += n.length - o.length;
    }
    const text = joinFile(f);
    if (pn !== po) {
      tree.now.set(po, null);
      tree.now.set(pn, text);
      moves.push({ old: po, new: pn });
    } else {
      tree.now.set(po, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => ({
    gitOld: null,
    gitNew: null,
    hdrOld: undefined,
    hdrNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    createFlag: false,
    delFlag: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      cur = newSection();
      cur.gitOld = x;
      cur.gitNew = y;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur === null || cur.hunks.length > 0) {
          cur = newSection();
          sections.push(cur);
        }
        cur.hdrOld = hdrPath(line);
        cur.hdrNew = hdrPath(next);
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('+++ ')) {
        cur.hdrNew = hdrPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.createFlag = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFlag = true;
        i++;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: UBody[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = l[0];
        if (l === '') body.push({ kind: 'ctx', text: '', emptyLine: true });
        else if (c === ' ') body.push({ kind: 'ctx', text: l.slice(1), emptyLine: false });
        else if (c === '-') body.push({ kind: 'old', text: l.slice(1), emptyLine: false });
        else if (c === '+') body.push({ kind: 'new', text: l.slice(1), emptyLine: false });
        else if (c === '\\') body.push({ kind: 'bs', text: '', emptyLine: false });
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.emptyLine) body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), body });
      i = j;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const o: Ent[] = oldLines.map((text) => ({ text, ctx: false }));
    const n: Ent[] = newLines.map((text) => ({ text, ctx: false }));
    const produced = produce(f.lines, pos, o, n, found.tier);
    f.lines.splice(pos, oldLines.length, ...produced);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let bound = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= bound; j--) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchNo}`);
      oldLines.push(lines[j]!);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    j++;
    const newLines: string[] = [];
    while (j < lines.length && lines[j]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j++;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    bound = j + 1;
    i = j + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** V4A patches (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (tierEq(f.lines[k]!, chunk.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o: Ent[] = [];
      const n: Ent[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          o.push({ text: b.text, ctx: true });
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'old') o.push({ text: b.text, ctx: false });
        else n.push({ text: b.text, ctx: false });
      }
      if (o.length === 0) {
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(pos, 0, ...n.map((e) => e.text));
        cursor = pos + n.length;
        continue;
      }
      const oTexts = o.map((e) => e.text);
      let picked: { tier: number; pos: number } | null = null;
      for (const t of strict ? [0] : [0, 1, 2]) {
        const occ = occurrences(f.lines, oTexts, t, cursor).filter((cand) => !chunk.eof || cand + o.length === f.lines.length);
        if (occ.length > 0) {
          picked = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (picked === null) throw new Fail('no-match', path);
      const produced = produce(f.lines, picked.pos, o, n, picked.tier);
      f.lines.splice(picked.pos, o.length, ...produced);
      cursor = picked.pos + produced.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lb = k;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const isAdd = line.startsWith('*** Add File:');
    const isDel = line.startsWith('*** Delete File:');
    const isUpd = line.startsWith('*** Update File:');
    if (!isAdd && !isDel && !isUpd) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const path = line.slice(line.indexOf(':') + 1).trim();
    const content: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < lb) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      content.push({ text: l, no: j + 1 });
      j++;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (isAdd) {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (isDel) {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (content.length > 0 && content[0]!.text.startsWith('*** Move to:')) {
        moveTo = content[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let curClosed = false;
      for (; idx < content.length; idx++) {
        const { text: l, no } = content[idx]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          curClosed = false;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur !== null && curClosed) throw new Exit2(`error: parse ${no}`);
          if (cur === null) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          curClosed = true;
          continue;
        }
        const c = l[0];
        const isBody = l === '' || c === ' ' || c === '-' || c === '+';
        if (!isBody) throw new Exit2(`error: parse ${no}`);
        if (cur === null || curClosed) {
          if (cur === null && chunks.length === 0) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            curClosed = false;
          } else {
            throw new Exit2(`error: parse ${no}`);
          }
        }
        if (l === '') cur.body.push({ kind: 'ctx', text: '' });
        else if (c === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
        else if (c === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
        else cur.body.push({ kind: 'new', text: l.slice(1) });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const mlen = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = mlen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rText = new Map<string, string>();
  const suppressed = new Set<string>();
  for (const m of moves) {
    if (suppressed.has(m.old) || rText.has(m.new)) continue;
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rText.set(m.new, `R ${m.old} -> ${m.new}`);
      suppressed.add(m.old);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (rText.has(p)) rows.push({ key: p, text: rText.get(p)! });
    else if (!suppressed.has(p) && was !== now) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
