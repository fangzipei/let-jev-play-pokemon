import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import * as api from '../src/jev/deadline.js';
beforeEach(() => vi.useFakeTimers({now: 1000}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const never = () => new Promise<never>(() => {});

describe('withDeadline', () => {
  it('无控制参数也提供内部 signal，并保留结果类型', async () => {
    const result = await api.withDeadline(async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return {answer: 42};
    }, {});
    expect(result).toEqual({answer: 42});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('绝对截止时间硬终止忽略 signal 的挂起操作', async () => {
    let inner: AbortSignal | undefined;
    let settled = false;
    const outcome = api.withDeadline((signal) => {
      inner = signal;
      return never();
    }, {deadlineAt: 1050}).catch((error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(api.DeadlineExceededError);
    expect(inner?.aborted).toBe(true);
    expect(inner?.reason).toBeInstanceOf(api.DeadlineExceededError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('过期预算不启动操作', async () => {
    const operation = vi.fn(never);
    await expect(api.withDeadline(operation, {deadlineAt: 1000})).rejects.toBeInstanceOf(api.DeadlineExceededError);
    expect(operation).not.toHaveBeenCalled();
  });

  it('已取消的请求不启动操作，也不泄露取消原因', async () => {
    const controller = new AbortController();
    controller.abort(new Error('private-credential'));
    const operation = vi.fn(never);
    const error = await api.withDeadline(operation, {signal: controller.signal}).catch((e) => e);
    expect(error).toBeInstanceOf(api.CallCancelledError);
    expect(String(error)).not.toContain('private-credential');
    expect(operation).not.toHaveBeenCalled();
  });

  it('外部取消硬终止挂起操作并清理父 listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    let inner: AbortSignal | undefined;
    const outcome = api.withDeadline((signal) => {
      inner = signal;
      return never();
    }, {signal: controller.signal, deadlineAt: 1200}).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(await outcome).toBeInstanceOf(api.CallCancelledError);
    expect(inner?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('父截止控制的超时原因仍为超时，不误报用户取消', async () => {
    const controller = new AbortController();
    const outcome = api.withDeadline(never, {signal: controller.signal}).catch((e) => e);
    controller.abort(new api.DeadlineExceededError());
    expect(await outcome).toBeInstanceOf(api.DeadlineExceededError);
  });

  it.each(['resolve', 'reject'] as const)('操作 %s 后清理 timer/listener', async (mode) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const failure = new Error('local failure');
    const result = await api.withDeadline(async () => {
      if (mode === 'reject') throw failure;
      return 42;
    }, {signal: controller.signal, deadlineAt: 1200}).catch((e) => e);
    expect(result).toBe(mode === 'resolve' ? 42 : failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('定时器尚未调度时也拒绝迟到结果并中止内部 signal', async () => {
    let inner: AbortSignal | undefined;
    await expect(api.withDeadline(async (signal) => {
      inner = signal;
      vi.setSystemTime(1100);
      return 'late';
    }, {deadlineAt: 1050})).rejects.toBeInstanceOf(api.DeadlineExceededError);
    expect(inner?.aborted).toBe(true);
    expect(inner?.reason).toBeInstanceOf(api.DeadlineExceededError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('取消后操作晚到的拒绝不会成为未处理异常', async () => {
    let rejectLate!: (error: Error) => void;
    const controller = new AbortController();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const outcome = api.withDeadline(() => new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      }), {signal: controller.signal}).catch((e) => e);
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect(await outcome).toBeInstanceOf(api.CallCancelledError);
      rejectLate(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.each([NaN, Infinity, -Infinity])('拒绝无效绝对截止值 %s', async (deadlineAt) => {
    const operation = vi.fn(never);
    await expect(api.withDeadline(operation, {deadlineAt})).rejects.toBeInstanceOf(RangeError);
    expect(operation).not.toHaveBeenCalled();
  });
});