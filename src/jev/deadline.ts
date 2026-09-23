export interface CallControl {
  signal?: AbortSignal;
  /** Unix 时间戳，单位毫秒；不是相对超时。 */
  deadlineAt?: number;
}

export class DeadlineExceededError extends Error {
  constructor() {
    super('调用超过截止时间 (timeout)');
    this.name = 'DeadlineExceededError';
  }
}

export class CallCancelledError extends Error {
  constructor() {
    super('调用已取消');
    this.name = 'CallCancelledError';
  }
}

/** 即使底层忽略 signal，也会在截止/取消时停止等待；不代表服务端停止计费。 */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  control: CallControl,
): Promise<T> {
  const {signal: parent, deadlineAt} = control;
  if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
    throw new RangeError('deadlineAt 必须是有限的绝对时间戳');
  }
  const controller = new AbortController();
  const cancellation = () => parent?.reason instanceof DeadlineExceededError
    ? new DeadlineExceededError() : new CallCancelledError();
  const check = () => {
    const error = parent?.aborted ? cancellation()
      : deadlineAt !== undefined && Date.now() >= deadlineAt ? new DeadlineExceededError() : null;
    if (error) {
      controller.abort(error);
      throw error;
    }
  };
  check();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (error: Error) => {
    rejectStop(error);
    controller.abort(error);
  };
  const onAbort = () => stop(cancellation());
  const schedule = () => {
    if (deadlineAt === undefined) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) stop(new DeadlineExceededError());
    else timer = setTimeout(schedule, Math.min(remaining, 2147483647));
  };
  parent?.addEventListener('abort', onAbort, {once: true});
  schedule();
  try {
    const running = Promise.resolve().then(async () => {
      try {
        check();
        const result = await operation(controller.signal);
        check();
        return result;
      } catch (error) {
        // 同步/微任务耗时可能先于 timer 回调越过截止时间。
        check();
        throw error;
      }
    });
    return await Promise.race([running, stopped]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}
