/** 轻量 Server-Timing 计时器（纯逻辑，可注入时钟便于测试）。 */
export function createServerTiming(now: () => number = () => performance.now()) {
  const marks: Array<[string, number]> = [];
  let last = now();
  const start = last;
  return {
    /** 记录自上一个 mark 以来的阶段耗时。 */
    mark(name: string) {
      const t = now();
      marks.push([name, t - last]);
      last = t;
    },
    header(): string {
      const parts = marks.map(([n, d]) => `${n.replace(/[^a-zA-Z0-9_-]/g, "_")};dur=${d.toFixed(1)}`);
      parts.push(`total;dur=${(now() - start).toFixed(1)}`);
      return parts.join(", ");
    },
    /** 给响应加 Server-Timing；只读头的响应会被复制一份。 */
    apply(res: Response): Response {
      try {
        res.headers.set("Server-Timing", this.header());
        return res;
      } catch {
        const copy = new Response(res.body, res);
        copy.headers.set("Server-Timing", this.header());
        return copy;
      }
    },
  };
}
