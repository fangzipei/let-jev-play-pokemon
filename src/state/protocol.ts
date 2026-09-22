export interface ProtocolLine {
  type: string;
  args: string[];
  raw: string;
}

export function parseLine(raw: string): ProtocolLine | null {
  if (!raw.startsWith('|')) return null;
  const parts = raw.split('|');
  parts.shift(); // 去掉前导空串
  const type = parts.shift() ?? '';
  return {type, args: parts, raw};
}

export interface Ident {
  side: string;
  pos: string;
  name: string;
}

export function parseIdent(token: string): Ident | null {
  const m = /^(p\d+)([a-z]?): (.*)$/.exec(token);
  if (!m) return null;
  return {side: m[1], pos: m[2] || 'a', name: m[3]};
}

export interface Details {
  species: string;
  level?: number;
  gender?: string;
}

export function parseDetails(token: string): Details {
  const parts = token.split(',').map(s => s.trim()).filter(Boolean);
  const species = parts[0] ?? '';
  let level: number | undefined;
  let gender: string | undefined;
  for (const p of parts.slice(1)) {
    if (/^L\d+$/.test(p)) level = Number(p.slice(1));
    else if (p === 'M' || p === 'F') gender = p;
  }
  return {species, level, gender};
}

export interface Condition {
  hp: number;
  maxhp: number;
  status: string | null;
  suffix: string;
  fainted: boolean;
}

/** 解析血量条件："100/100" | "35/100 brn" | "50/100g" | "0 fnt" */
export function parseCondition(token: string): Condition {
  const t = token.trim();
  const m = /^(\d+)\/(\d+)([a-z]*)(?:\s+(.+))?$/.exec(t);
  if (m) {
    const hp = Number(m[1]);
    const maxhp = Number(m[2]);
    const suffix = m[3] ?? '';
    const status = (m[4] ?? '').trim() || (hp <= 0 ? 'fnt' : null);
    return {hp, maxhp, status, suffix, fainted: hp <= 0};
  }
  const m2 = /^(\d+)(?:\s+(.+))?$/.exec(t);
  if (m2) {
    const hp = Number(m2[1]);
    return {hp, maxhp: 100, status: (m2[2] ?? '').trim() || (hp <= 0 ? 'fnt' : null), suffix: '', fainted: hp <= 0};
  }
  return {hp: 100, maxhp: 100, status: null, suffix: '', fainted: false};
}

export function hpPercent(hp: number, maxhp: number): number {
  if (maxhp <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((hp / maxhp) * 100)));
}

export function toId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
