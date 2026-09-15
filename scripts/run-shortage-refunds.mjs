// 缺货退款执行 worker 的定时入口：systemd/cron 提供环境变量，令牌不出现在 argv 或日志中。
// 生产执行默认关闭（SHORTAGE_REFUND_WORKER_ENABLED=true 才会真正调用支付通道）。
const token = process.env.SHORTAGE_REFUND_WORKER_TOKEN;
const base = process.env.SHORTAGE_REFUND_WORKER_URL ?? 'http://127.0.0.1:3005';
if (!token || token.length < 32) {
  console.error('Shortage refund worker is not configured');
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`${base}/api/internal/refunds/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(170000),
    });
    const data = await response.json();
    console.log(JSON.stringify({
      ok: response.ok && data.ok === true,
      code: typeof data.code === 'string' ? data.code : null,
      attempted: Number.isInteger(data.attempted) ? data.attempted : null,
      succeeded: Number.isInteger(data.succeeded) ? data.succeeded : null,
      pending: Number.isInteger(data.pending) ? data.pending : null,
      failed: Number.isInteger(data.failed) ? data.failed : null,
    }));
    if (!response.ok || data.ok !== true) process.exitCode = 1;
  } catch {
    console.error('Refund worker request failed; inspect commerce_refund_intents, do not create new refunds by hand');
    process.exitCode = 1;
  }
}
