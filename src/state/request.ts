export interface MoveRequest {
  move: string;
  id: string;
  pp: number;
  maxpp: number;
  target: string;
  disabled?: boolean;
}

export interface RequestActive {
  moves: MoveRequest[];
  canMegaEvo?: boolean;
  canTerastallize?: string;
  canUltraBurst?: boolean;
  canZMove?: unknown[];
  trapped?: boolean;
  maybeTrapped?: boolean;
  maybeDisabled?: boolean;
}

export interface RequestPokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  stats?: Record<string, number>;
  moves?: string[];
  item?: string;
  ability?: string;
  baseAbility?: string;
}

export interface RequestSide {
  name: string;
  id: string;
  pokemon: RequestPokemon[];
}

export interface BattleRequest {
  active?: RequestActive[];
  side: RequestSide;
  rqid?: number;
  forceSwitch?: boolean[];
  wait?: boolean;
  teamPreview?: boolean;
}

export function parseRequest(json: string): BattleRequest | null {
  try {
    const obj = JSON.parse(json) as BattleRequest;
    if (!obj || typeof obj !== 'object' || !obj.side || !Array.isArray(obj.side.pokemon)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** request.side.pokemon 中 active 的条目，数组顺序与 request.active 的槽位顺序一致 */
export function activeEntries(request: BattleRequest): RequestPokemon[] {
  return request.side.pokemon.filter(p => p.active);
}

/** 存活且未上场的替补（switch 目标） */
export function benchEntries(request: BattleRequest): RequestPokemon[] {
  return request.side.pokemon.filter(p => !p.active && !/(^|\s)fnt$/.test(p.condition));
}

/** 从 request 里取队伍的 1-based 槽位号 */
export function teamSlotOf(request: BattleRequest, pokemon: RequestPokemon): number {
  return request.side.pokemon.indexOf(pokemon) + 1;
}

export function speciesOf(pokemon: {details: string}): string {
  return pokemon.details.split(',')[0].trim();
}

export function conditionPercent(condition: string): number {
  const m = /^(\d+)\/(\d+)/.exec(condition.trim());
  if (!m) return condition.includes('fnt') ? 0 : 100;
  return Math.round((Number(m[1]) / Number(m[2])) * 100);
}

export function isFainted(condition: string): boolean {
  return /fnt/.test(condition);
}
