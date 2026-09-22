import type {Logger} from '../log/logger.js';
import {toId} from '../state/protocol.js';

const LOGIN_URL = 'https://play.pokemonshowdown.com/api/login';
const ACTION_URL = 'https://play.pokemonshowdown.com/action.php';

/**
 * 解析登录端点返回的 assertion。
 * 容忍：前导 `]`（防 JSON 劫持）、前导 `;;;`（旧 action.php）、纯字符串、完整 JSON。
 * JSON 里没有 assertion 字段 → 返回空串（视为失败）。
 */
export function parseAssertion(raw: string): string {
  const text = raw.trim().replace(/^]/, '').replace(/^;;;/, '').trim();
  if (!text) return '';
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as {assertion?: unknown};
      return typeof obj?.assertion === 'string' ? obj.assertion : '';
    } catch {
      return '';
    }
  }
  return text;
}

export function buildTrnCommand(name: string, assertion: string): string {
  return `/trn ${name},0,${assertion}`;
}

export interface GetAssertionOptions {
  name: string;
  password?: string;
  challstr: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** 先走 /api/login（POST 表单），失败回退 action.php（GET）（spec 不确定项 2） */
export async function getAssertion(opts: GetAssertionOptions): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({name: opts.name, pass: opts.password ?? '', challstr: opts.challstr});
  try {
    const res = await doFetch(LOGIN_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: body.toString(),
    });
    if (res.ok) {
      const assertion = parseAssertion(await res.text());
      if (assertion) return assertion;
      opts.logger?.warn('/api/login 响应中没有 assertion，回退 action.php');
    } else {
      opts.logger?.warn(`/api/login 返回 ${res.status}，回退 action.php`);
    }
  } catch (err) {
    opts.logger?.warn(`/api/login 请求失败（${err instanceof Error ? err.message : String(err)}），回退 action.php`);
  }
  const url = `${ACTION_URL}?act=getassertion&userid=${toId(opts.name)}&challstr=${encodeURIComponent(opts.challstr)}`;
  const res = await doFetch(url, {method: 'GET'});
  if (!res.ok) throw new Error(`action.php 登录失败: HTTP ${res.status}`);
  const assertion = parseAssertion(await res.text());
  if (!assertion) throw new Error('登录端点没有返回 assertion');
  return assertion;
}
