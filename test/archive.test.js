import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { ArchiveMonitor, pdfType, safeFilename, archiveName, isCompletePdf } from '../archive.js';

const tempRoot = path.resolve(import.meta.dirname, '../.test-work');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function pdf(text = 'translated') {
  const stream = `BT /F1 12 Tf 20 80 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  value += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}

async function fixture(t, overrides = {}) {
  await fs.mkdir(tempRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempRoot, 'archive-test-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(source);
  const history = [];
  const tasks = [];
  const downloads = new Map();
  const server = createServer((request, response) => {
    if (request.url === '/api/history') response.end(JSON.stringify({ status: 'success', history }));
    else if (request.url === '/api/tasks') response.end(JSON.stringify({ status: 'success', tasks }));
    else if (request.url.startsWith('/translatedFile/')) {
      const bytes = downloads.get(decodeURIComponent(request.url.slice('/translatedFile/'.length)));
      if (!bytes) { response.writeHead(404); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'application/pdf' }); response.end(bytes); }
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    sourceDirectory: source, targetDirectory: target, dataDirectory: path.join(root, 'data'),
    serverUrl: `http://127.0.0.1:${server.address().port}`, stableMs: 0, pollIntervalMs: 25,
    requestTimeoutMs: 200, ...overrides
  };
  const monitor = new ArchiveMonitor(config);
  await monitor.init();
  t.after(async () => {
    await monitor.stop();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(root).startsWith(path.resolve(tempRoot) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const add = async (id, names = ['paper.zh.mono.pdf', 'paper.zh.dual.pdf'], extra = {}) => {
    for (const name of names) await fs.writeFile(path.join(source, name), pdf(`${id}-${pdfType(name)}`));
    const record = { taskId: id, status: 'success', active: false, finished: true, service: 'deepseek',
      endTime: `2026-09-30T12:00:${id}`, fileList: names, ...extra };
    history.unshift(record);
    return record;
  };
  return { root, source, target, config, monitor, history, tasks, downloads, server, add };
}

test('recognizes only mono/dual PDFs and rejects path traversal', () => {
  assert.equal(pdfType('paper.zh.mono.pdf'), 'mono');
  assert.equal(pdfType('paper-dual.pdf'), 'dual');
  assert.equal(pdfType('paper.no_watermark.zh-CN.LR_dual.pdf'), 'dual');
  assert.equal(pdfType('paper.zh-CN.TB_dual.pdf'), 'dual');
  assert.equal(pdfType('paper.compare.pdf'), 'dual');
  assert.equal(pdfType('paper.dual-cut.pdf'), null);
  assert.equal(pdfType('paper.pdf'), null);
  for (const value of ['../paper.mono.pdf', 'C:\\paper.mono.pdf', '/tmp/a.pdf', '', 'x.txt']) {
    assert.throws(() => safeFilename(value));
  }
  assert.equal(archiveName('paper.zh.dual.pdf', 'dual'), 'paper.zh_中英双语.pdf');
  assert.match(archiveName('CON.mono.pdf', 'mono'), /^paper_CON/);
});

test('rejects incomplete PDFs and nonlocal endpoints', () => {
  assert.equal(isCompletePdf(pdf()), true);
  assert.equal(isCompletePdf(Buffer.from('%PDF-1.4\nunfinished')), false);
  assert.equal(isCompletePdf(Buffer.from('<html>%%EOF</html>')), false);
  assert.throws(() => new ArchiveMonitor({ serverUrl: 'http://example.com' }));
  assert.throws(() => new ArchiveMonitor({ serverUrl: 'http://user:secret@localhost:8890' }));
});

test('archives both output types, preserves originals, and deduplicates repeated polls', async t => {
  const f = await fixture(t);
  await f.add('01');
  await f.monitor.tick();
  const names = await fs.readdir(f.target);
  assert.deepEqual(names.sort(), ['paper.zh_中英双语.pdf', 'paper.zh_中文译文.pdf'].sort());
  assert.deepEqual(await fs.readFile(path.join(f.target, 'paper.zh_中文译文.pdf')),
    await fs.readFile(path.join(f.source, 'paper.zh.mono.pdf')));
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 2);
  assert.equal(Object.keys(f.monitor.state.done).length, 1);
});

test('ignores running, failed, other-provider, original, and cropped outputs', async t => {
  const f = await fixture(t);
  await f.add('01', ['paper.zh.mono.pdf'], { status: 'failed', error: 'failed' });
  await f.add('02', ['paper.zh.dual.pdf'], { active: true });
  await f.add('03', ['other.zh.dual.pdf'], { service: 'google' });
  await f.add('04', ['paper.pdf', 'paper.dual-cut.pdf']);
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 0);
});

test('batch completion in active-task API works and malformed task does not block valid tasks', async t => {
  const f = await fixture(t);
  const first = await f.add('01');
  const second = await f.add('02', ['another-mono.pdf', 'another-dual.pdf']);
  f.history.length = 0;
  f.tasks.push({ ...first, status: '完成' }, { ...second, status: '完成' },
    { ...first, taskId: 'bad', fileList: ['../escape.mono.pdf'] });
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 4);
  assert.equal(Object.keys(f.monitor.state.done).length, 2);
  assert.match(await fs.readFile(f.monitor.logPath, 'utf8'), /已跳过异常任务/);
});

test('local PDF2zh 4.1.7 canonical LR/TB naming and compare fallback are supported', async t => {
  const f = await fixture(t);
  await f.add('01', ['next.no_watermark.zh-CN.mono.pdf', 'next.no_watermark.zh-CN.LR_dual.pdf', 'next.compare.pdf']);
  await f.add('02', ['compare-only.compare.pdf']);
  await f.monitor.tick();
  const names = await fs.readdir(f.target);
  assert.equal(names.length, 3);
  assert.ok(names.includes('next.no_watermark.zh-CN_中英双语.pdf'));
  assert.ok(names.includes('compare-only_中英双语.pdf'));
});

test('same-name new content is preserved without overwriting previous translation', async t => {
  const f = await fixture(t);
  await f.add('01');
  await f.monitor.tick();
  const original = await fs.readFile(path.join(f.target, 'paper.zh_中文译文.pdf'));
  await f.add('02');
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 4);
  assert.deepEqual(await fs.readFile(path.join(f.target, 'paper.zh_中文译文.pdf')), original);
});

test('same content from a different task reuses the existing file', async t => {
  const f = await fixture(t);
  const record = await f.add('01');
  await f.monitor.tick();
  f.history.unshift({ ...record, taskId: '02' });
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 2);
  assert.equal(Object.keys(f.monitor.state.done).length, 2);
});

test('incomplete file stays queued and retries after repair', async t => {
  const f = await fixture(t);
  await f.add('01');
  await fs.writeFile(path.join(f.source, 'paper.zh.dual.pdf'), '%PDF-1.4\nunfinished');
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 1);
  assert.equal(Object.keys(f.monitor.state.pending).length, 1);
  await fs.writeFile(path.join(f.source, 'paper.zh.dual.pdf'), pdf('fixed'));
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 2);
  assert.equal(Object.keys(f.monitor.state.pending).length, 0);
});

test('pending queue survives restart and completes with service offline', async t => {
  const f = await fixture(t);
  await f.add('01');
  await fs.writeFile(path.join(f.source, 'paper.zh.dual.pdf'), '%PDF-1.4\nunfinished');
  await f.monitor.tick();
  await f.monitor.stop();
  await fs.writeFile(path.join(f.source, 'paper.zh.dual.pdf'), pdf('repaired'));
  const resumed = new ArchiveMonitor({ ...f.config, serverUrl: 'http://127.0.0.1:1' });
  await resumed.init();
  t.after(() => resumed.stop());
  await resumed.tick();
  assert.equal(Object.keys(resumed.state.pending).length, 0);
  assert.equal((await fs.readdir(f.target)).length, 2);
});

test('HTTP file download fallback supports Unicode names without any API key', async t => {
  const f = await fixture(t);
  const names = ['论文.zh.mono.pdf', '论文.zh.dual.pdf'];
  for (const name of names) f.downloads.set(name, pdf('remote'));
  f.history.push({ taskId: 'remote', status: 'success', service: 'deepseek', fileList: names });
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 2);
});

test('oversized PDF is not saved and missing output type is explained', async t => {
  const f = await fixture(t, { maxPdfBytes: 100 });
  await f.add('01', ['paper.zh.mono.pdf']);
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 0);
  assert.match(await fs.readFile(f.monitor.logPath, 'utf8'), /同时启用中文与双语输出/);
});

test('file changed during stability window is deferred', async t => {
  const f = await fixture(t, { stableMs: 60 });
  await f.add('01', ['paper.zh.mono.pdf']);
  const polling = f.monitor.tick();
  await wait(20);
  await fs.writeFile(path.join(f.source, 'paper.zh.mono.pdf'), pdf('changed during copy'));
  await polling;
  assert.equal(Object.keys(f.monitor.state.pending).length, 1);
  assert.equal((await fs.readdir(f.target)).length, 0);
  await f.monitor.tick();
  assert.equal((await fs.readdir(f.target)).length, 1);
});

test('second active instance is rejected, and state corruption is not discarded', async t => {
  const f = await fixture(t);
  const second = new ArchiveMonitor(f.config);
  await assert.rejects(second.init(), /另一个归档实例/);
  await f.monitor.stop();
  await fs.writeFile(f.monitor.statePath, 'not-json');
  const broken = new ArchiveMonitor(f.config);
  await assert.rejects(broken.init());
  await assert.rejects(fs.stat(broken.lockPath), { code: 'ENOENT' });
});

test('start runs automatically, stop releases lock and stops polling', async t => {
  const f = await fixture(t);
  await f.monitor.stop();
  const automated = new ArchiveMonitor(f.config);
  t.after(() => automated.stop());
  await automated.start();
  await f.add('01');
  for (let i = 0; i < 40 && !Object.keys(automated.state.done).length; i++) await wait(10);
  assert.equal((await fs.readdir(f.target)).length, 2);
  await automated.stop();
  await assert.rejects(fs.stat(automated.lockPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(automated.statusPath, 'utf8')).running, false);
});
