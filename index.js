import { readFileSync } from 'node:fs';
import { ArchiveMonitor } from './archive.js';

export function apply(ctx, rowConfig = {}) {
  const config = { ...JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8')), ...rowConfig };
  if (config.enabled === false) return;
  ctx.effect(() => {
    const monitor = new ArchiveMonitor(config);
    monitor.start().catch(error => console.error('[zotero-pdf2zh-archive] 启动失败：', error.message));
    return () => monitor.stop();
  });
}
