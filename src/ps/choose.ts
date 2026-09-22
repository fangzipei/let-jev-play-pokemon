import type {BattleRequest} from '../state/request.js';

export type ChooseAction =
  | {kind: 'move'; slot: 1 | 2; moveIndex: number; target?: string; mega?: boolean}
  | {kind: 'switch'; slot: 1 | 2; teamIndex: number}
  | {kind: 'pass'; slot: 1 | 2}
  | {kind: 'slot-default'; slot: 1 | 2}
  | {kind: 'team'; order: number[]}
  | {kind: 'default'};

export interface ChooseOptions {
  rqid?: number;
  sendRqid?: boolean;
}

function slotOf(action: ChooseAction): number {
  return 'slot' in action ? action.slot : 0;
}

export function buildChooseCommand(actions: ChooseAction[], opts: ChooseOptions = {}): string {
  const suffix = opts.sendRqid !== false && opts.rqid != null ? `|${opts.rqid}` : '';
  if (actions.length === 1 && actions[0].kind === 'default') return `/choose default${suffix}`;
  if (actions.length === 1 && actions[0].kind === 'team') {
    return `/choose team ${actions[0].order.join('')}${suffix}`;
  }
  const parts = [...actions]
    .filter(a => a.kind !== 'default' && a.kind !== 'team')
    .sort((a, b) => slotOf(a) - slotOf(b))
    .map(a => {
      switch (a.kind) {
        case 'move':
          return `move ${a.moveIndex}${a.target ? ` ${a.target}` : ''}${a.mega ? ' mega' : ''}`;
        case 'switch':
          return `switch ${a.teamIndex}`;
        case 'pass':
          return 'pass';
        default:
          return 'default';
      }
    });
  return `/choose ${parts.join(', ')}${suffix}`;
}

/** 返回问题列表；空数组表示合法 */
export function validateActions(actions: ChooseAction[], request?: BattleRequest): string[] {
  const problems: string[] = [];
  const slots = new Set<number>();
  const switchTargets = new Set<number>();
  let megaCount = 0;
  for (const a of actions) {
    if (a.kind === 'default') continue;
    if (a.kind === 'team') {
      if (a.order.length !== 6 || new Set(a.order).size !== 6 || a.order.some(n => n < 1 || n > 6)) {
        problems.push(`team order 非法: ${a.order.join('')}`);
      }
      continue;
    }
    if (a.slot !== 1 && a.slot !== 2) problems.push(`非法槽位: ${a.slot}`);
    if (slots.has(a.slot)) problems.push(`槽位重复: ${a.slot}`);
    slots.add(a.slot);
    if (a.kind === 'move') {
      if (a.moveIndex < 1 || a.moveIndex > 4) problems.push(`非法招式槽位: ${a.moveIndex}`);
      if (a.mega) megaCount++;
      if (a.target && !/^[+-]?\d$/.test(a.target)) problems.push(`非法目标: ${a.target}`);
      if (request) {
        const active = request.active?.[a.slot - 1];
        const mv = active?.moves[a.moveIndex - 1];
        if (!mv) problems.push(`槽位 ${a.slot} 没有第 ${a.moveIndex} 个招式`);
        else if (mv.disabled || mv.pp <= 0) problems.push(`招式不可用: ${mv.move}`);
      }
    }
    if (a.kind === 'switch') {
      // 同一只替补不能被两个槽位重复选中（服务器 side.ts 报 "can only switch in once"）
      if (switchTargets.has(a.teamIndex)) problems.push(`换人目标重复: ${a.teamIndex}`);
      switchTargets.add(a.teamIndex);
      if (a.teamIndex < 1 || a.teamIndex > 6) problems.push(`非法换人槽位: ${a.teamIndex}`);
      if (request) {
        const target = request.side.pokemon[a.teamIndex - 1];
        if (!target) problems.push(`换人目标不存在: ${a.teamIndex}`);
        else if (target.active) problems.push(`换人目标已在场: ${a.teamIndex}`);
      }
    }
  }
  if (megaCount > 1) problems.push(`一次只能 Mega 一只，当前 ${megaCount} 只`);
  return problems;
}
