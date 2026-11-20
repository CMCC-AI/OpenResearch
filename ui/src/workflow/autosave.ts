/** 防抖自动保存调度器：编辑改动落在短定时器上，导航前用 flush 收尾。
 * `save` 必须是读取最新状态的稳定闭包（组件里用 ref 转发），调度器只管时机与串行。 */
export function createAutosave(save: () => Promise<void>, delayMs = 800) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 串行化：保存进行中又来的触发排成一次尾部重跑，保证落盘的是最新内容。
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  const run = (): Promise<void> => {
    const next = chain.then(() => save());
    // 链条吞掉失败继续走下去；错误状态由 save 闭包自行记录，下一次修改或 flush 会重试。
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    /** 有改动后调用：重置防抖定时器。 */
    schedule() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run().catch(() => {}); }, delayMs);
    },
    /** 撤掉还没触发的定时器（提交/复制前由调用方显式保存时用）。 */
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
    /** 立即结算：有挂起的改动就补一次保存，并等所有排队的保存结束。 */
    flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; void run(); }
      return chain;
    },
    /** 编辑器卸载：先尽力补发挂起的保存，再停掉定时器。 */
    dispose(): Promise<void> {
      const done = this.flush();
      disposed = true;
      return done;
    },
  };
}
