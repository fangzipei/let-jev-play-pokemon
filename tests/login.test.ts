import {describe, expect, it} from 'vitest';
import {buildTrnCommand, getAssertion, parseAssertion} from '../src/ps/login.js';

describe('parseAssertion', () => {
  it('容忍前导 ] 的 JSON', () => {
    expect(parseAssertion(']{"assertion":"abc123"}')).toBe('abc123');
  });

  it('纯字符串与 ;;; 前缀', () => {
    expect(parseAssertion(';;;raw-assertion')).toBe('raw-assertion');
    expect(parseAssertion('plain')).toBe('plain');
  });

  it('JSON 但没有 assertion 字段时返回空串', () => {
    expect(parseAssertion(']{"error":"bad"}')).toBe('');
    expect(parseAssertion('')).toBe('');
  });
});

describe('getAssertion', () => {
  it('优先 /api/login（POST + 表单体）', async () => {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({url: String(url), init});
      return new Response(']{"assertion":"a1"}', {status: 200});
    }) as typeof fetch;
    const assertion = await getAssertion({name: 'JevBot1', password: '', challstr: '4|xyz', fetchImpl});
    expect(assertion).toBe('a1');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/api/login');
    expect(calls[0].init?.method).toBe('POST');
    expect(String(calls[0].init?.body)).toContain('challstr=4%7Cxyz');
  });

  it('/api/login 失败时回退 action.php', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/api/login')) return new Response('nope', {status: 500});
      return new Response(';;;a2', {status: 200});
    }) as typeof fetch;
    const assertion = await getAssertion({name: 'JevBot1', password: '', challstr: '4|xyz', fetchImpl});
    expect(assertion).toBe('a2');
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain('action.php');
    expect(urls[1]).toContain('act=getassertion');
    expect(urls[1]).toContain('userid=jevbot1');
  });

  it('两个端点都失败时抛错', async () => {
    const fetchImpl = (async () => new Response('', {status: 500})) as typeof fetch;
    await expect(getAssertion({name: 'x', challstr: '4|y', fetchImpl})).rejects.toThrow();
  });
});

describe('buildTrnCommand', () => {
  it('拼出 /trn 指令', () => {
    expect(buildTrnCommand('JevBot1', 'assert')).toBe('/trn JevBot1,0,assert');
  });
});
