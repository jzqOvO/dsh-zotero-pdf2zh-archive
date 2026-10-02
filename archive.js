import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function pdfType(name) {
  const match = /(?:[.-])(?:(?:LR|TB)_)?(mono|dual)(?:[._-](?:LR|TB))?\.pdf$/i.exec(name);
  if (match) return match[1].toLowerCase();
  // PDF2zh 4.1.7 also exposes bilingual side-by-side output as .compare.pdf.
  return /(?:[.-])compare\.pdf$/i.test(name) ? 'dual' : null;
}

export function safeFilename(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('服务返回了不安全的文件名');
  }
  if (!/\.pdf$/i.test(name)) throw new Error('不是 PDF 文件');
  return name;
}

export function archiveName(name, type) {
  let stem = name.replace(/\.pdf$/i, '').replace(/(?:[.-])(?:(?:LR|TB)_)?(?:mono|dual)(?:[._-](?:LR|TB))?$/i, '')
    .replace(/(?:[.-])compare$/i, '');
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!stem || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = `paper_${stem}`;
  const short = [...stem].slice(0, 100).join('');
  return `${short}_${type === 'mono' ? '中文译文' : '中英双语'}.pdf`;
}

export function resolveDesktop() {
  if (process.platform === 'win32') {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  }
  return path.join(homedir(), 'Desktop');
}

export function isCompletePdf(bytes) {
  return bytes.length > 20 && bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) &&
    bytes.subarray(Math.max(0, bytes.length - 8192)).includes(Buffer.from('%%EOF'));
}

function normalizeConfig(raw) {
  const url = new URL(raw.serverUrl ?? 'http://127.0.0.1:8890');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('本版本只连接本机 HTTP PDF2zh 服务');
  }
  const targetDirectory = path.resolve(raw.targetDirectory || path.join(resolveDesktop(), '文献'));
  const dataDirectory = path.resolve(raw.dataDirectory || path.join(targetDirectory, '.pdf2zh-archive'));
  const outputTypes = raw.outputTypes ?? ['mono', 'dual'];
  if (!Array.isArray(outputTypes) || !outputTypes.length || outputTypes.some(t => !['mono', 'dual'].includes(t))) {
    throw new Error('outputTypes 必须包含 mono 或 dual');
  }
  const config = {
    ...raw, serverUrl: url.origin, targetDirectory, dataDirectory, outputTypes,
    sourceDirectory: raw.sourceDirectory ? path.resolve(raw.sourceDirectory) : null,
    serviceFilter: raw.serviceFilter ?? 'deepseek',
    pollIntervalMs: raw.pollIntervalMs ?? 3000,
    requestTimeoutMs: raw.requestTimeoutMs ?? 10000,
    stableMs: raw.stableMs ?? 1500,
    maxPdfBytes: raw.maxPdfBytes ?? 268435456
  };
  for (const key of ['pollIntervalMs', 'requestTimeoutMs', 'maxPdfBytes']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new Error(`${key} 必须为正数`);
  }
  if (!Number.isFinite(config.stableMs) || config.stableMs < 0) throw new Error('stableMs 无效');
  return config;
}

export class ArchiveMonitor {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.state = { version: 1, pending: {}, done: {} };
    this.statePath = path.join(this.config.dataDirectory, 'state.json');
    this.statusPath = path.join(this.config.dataDirectory, 'status.json');
    this.logPath = path.join(this.config.dataDirectory, 'archive.log');
    this.lockPath = path.join(this.config.dataDirectory, 'monitor.lock');
    this.running = false;
    this.busy = false;
    this.stopped = false;
    this.abort = new AbortController();
    this.lastError = '';
    this.missingTypes = new Set();
  }

  async init() {
    await fs.mkdir(this.config.dataDirectory, { recursive: true });
    await fs.mkdir(this.config.targetDirectory, { recursive: true });
    try {
      this.lock = await fs.open(this.lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      try {
        process.kill(lock.pid, 0);
      } catch (check) {
        if (check.code !== 'ESRCH') throw new Error('另一个归档实例仍在运行');
        await fs.unlink(this.lockPath);
        this.lock = await fs.open(this.lockPath, 'wx');
      }
      if (!this.lock) throw new Error('另一个归档实例仍在运行');
    }
    await this.lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }));
    try {
      this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (this.state.version !== 1 || !this.state.pending || !this.state.done) throw new Error('归档状态格式无效');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.releaseLock();
        throw error;
      }
    }
  }

  async releaseLock() {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = null;
    await fs.unlink(this.lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async atomicJson(filename, value) {
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
      await fs.rename(temp, filename);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }

  async saveState() { await this.atomicJson(this.statePath, this.state); }

  async log(message) {
    const clean = String(message).replace(/[\r\n]/g, ' ').slice(0, 1200);
    await fs.appendFile(this.logPath, `${new Date().toISOString()} ${clean}\n`);
  }

  async fetchBytes(route, limit) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    const response = await fetch(`${this.config.serverUrl}${route}`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`PDF2zh ${route.split('?')[0]} 返回 HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw new Error('服务响应超过大小限制');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('服务响应超过大小限制');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async fetchJson(route) {
    const value = JSON.parse((await this.fetchBytes(route, 4 * 1024 * 1024)).toString('utf8'));
    if (value.status !== 'success') throw new Error(`PDF2zh ${route} 未返回成功状态`);
    return value;
  }

  accepts(task) {
    if (!['success', '完成'].includes(task.status) || task.active === true || task.error) return false;
    if (this.config.serviceFilter === '*') return true;
    return String(task.service ?? '').toLowerCase() === this.config.serviceFilter.toLowerCase();
  }

  async enqueue(task) {
    if (!this.accepts(task) || typeof task.taskId !== 'string' || !task.taskId) return;
    const key = digest(Buffer.from(`${task.taskId}\n${task.endTime ?? task.startTime ?? ''}`));
    if (this.state.done[key] || this.state.pending[key]) return;
    const files = task.fileList ?? task.result?.fileList;
    if (!Array.isArray(files)) return;
    let selected = [...new Set(files.map(safeFilename))].filter(name => this.config.outputTypes.includes(pdfType(name)));
    if (selected.some(name => pdfType(name) === 'dual' && !/(?:[.-])compare\.pdf$/i.test(name))) {
      selected = selected.filter(name => !/(?:[.-])compare\.pdf$/i.test(name));
    }
    if (!selected.length) return;
    const absent = this.config.outputTypes.filter(type => !selected.some(name => pdfType(name) === type));
    if (absent.length && !this.missingTypes.has(key)) {
      this.missingTypes.add(key);
      await this.log(`任务 ${task.taskId} 未生成 ${absent.join(',')}：请在 PDF2zh 设置中同时启用中文与双语输出。`);
    }
    this.state.pending[key] = {
      taskId: task.taskId, endTime: task.endTime ?? '', files: selected,
      archived: {}, attempts: 0
    };
  }

  async readPdf(name) {
    safeFilename(name);
    if (this.config.sourceDirectory) {
      const filename = path.join(this.config.sourceDirectory, name);
      try {
        const root = await fs.realpath(this.config.sourceDirectory);
        const actual = await fs.realpath(filename);
        if (path.relative(root, actual).startsWith('..') || path.isAbsolute(path.relative(root, actual))) {
          throw new Error('译文路径超出输出目录');
        }
        const before = await fs.stat(actual);
        if (!before.isFile() || before.size > this.config.maxPdfBytes) throw new Error('译文大小或类型无效');
        await pause(this.config.stableMs);
        const bytes = await fs.readFile(actual);
        const after = await fs.stat(actual);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.size !== bytes.length) {
          throw new Error('译文仍在写入，稍后重试');
        }
        return bytes;
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
    return this.fetchBytes(`/translatedFile/${encodeURIComponent(name)}`, this.config.maxPdfBytes);
  }

  async commit(name, bytes) {
    if (!isCompletePdf(bytes)) throw new Error('译文 PDF 不完整，等待下次重试');
    const hash = digest(bytes);
    const preferred = archiveName(name, pdfType(name));
    const stem = preferred.slice(0, -4);
    const candidates = [preferred, `${stem}_${hash.slice(0, 12)}.pdf`, `${stem}_${hash}.pdf`];
    for (const candidate of candidates) {
      const destination = path.join(this.config.targetDirectory, candidate);
      try {
        const existing = await fs.readFile(destination);
        if (digest(existing) === hash) return { path: destination, sha256: hash, bytes: bytes.length };
        continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const temp = path.join(this.config.targetDirectory, `.pdf2zh-${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temp, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        // Hard-link publication is atomic and refuses to overwrite an existing file.
        // On filesystems without hard links, exclusive copy still protects existing files.
        try { await fs.link(temp, destination); }
        catch (error) {
          if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) {
            await fs.copyFile(temp, destination, constants.COPYFILE_EXCL);
          } else throw error;
        }
        const saved = await fs.readFile(destination);
        if (digest(saved) !== hash) throw new Error('保存后校验失败');
        await this.log(`已保存：${candidate}`);
        return { path: destination, sha256: hash, bytes: bytes.length };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (digest(await fs.readFile(destination)) === hash) return { path: destination, sha256: hash, bytes: bytes.length };
      } finally { await fs.unlink(temp).catch(() => {}); }
    }
    throw new Error('文件名冲突，原文件已保留');
  }

  async drain() {
    for (const [key, job] of Object.entries(this.state.pending)) {
      if (this.stopped) break;
      try {
        for (const name of job.files) {
          if (this.stopped) break;
          const record = job.archived[name];
          if (record) {
            try { if (digest(await fs.readFile(record.path)) === record.sha256) continue; } catch {}
          }
          job.archived[name] = await this.commit(name, await this.readPdf(name));
          await this.saveState();
        }
        if (this.stopped) break;
        this.state.done[key] = { taskId: job.taskId, savedAt: new Date().toISOString(), files: job.archived };
        delete this.state.pending[key];
        await this.saveState();
      } catch (error) {
        job.attempts += 1;
        if (job.lastError !== error.message) {
          await this.log(`任务 ${job.taskId} 待重试：${error.message}`);
          job.lastError = error.message;
        }
        await this.saveState();
      }
    }
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let connected = false;
    try {
      try {
        const results = await Promise.allSettled([this.fetchJson('/api/history'), this.fetchJson('/api/tasks')]);
        for (let i = 0; i < results.length; i++) {
          if (results[i].status !== 'fulfilled') continue;
          const tasks = results[i].value[i === 0 ? 'history' : 'tasks'];
          if (!Array.isArray(tasks)) throw new Error('PDF2zh 任务列表格式无效');
          connected = true;
          for (const task of [...tasks].reverse()) {
            try { await this.enqueue(task); }
            catch (error) { await this.log(`已跳过异常任务：${error.message}`); }
          }
        }
        if (!connected) throw results[0].reason;
        await this.saveState();
        if (this.lastError) { await this.log('PDF2zh 服务连接已恢复'); this.lastError = ''; }
      } catch (error) {
        if (this.lastError !== error.message) {
          await this.log(`等待 PDF2zh 服务：${error.message}`);
          this.lastError = error.message;
        }
      }
      await this.drain();
      await this.atomicJson(this.statusPath, {
        updatedAt: new Date().toISOString(), running: !this.stopped, connected,
        targetDirectory: this.config.targetDirectory,
        pendingTasks: Object.keys(this.state.pending).length,
        completedTasks: Object.keys(this.state.done).length,
        lastError: this.lastError
      });
    } finally { this.busy = false; }
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      await this.init();
      await this.log('归档插件已启动');
      if (this.stopped) { await this.releaseLock(); return; }
      await this.tick();
      const schedule = () => {
        if (this.stopped) return;
        this.timer = setTimeout(async () => {
          try { await this.tick(); }
          catch (error) { console.error('[zotero-pdf2zh-archive]', error.message); }
          schedule();
        }, this.config.pollIntervalMs);
        this.timer.unref?.();
      };
      schedule();
    } catch (error) {
      this.running = false;
      await this.releaseLock();
      throw error;
    }
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    while (this.busy) await pause(25);
    await this.releaseLock();
    this.running = false;
    try {
      const status = JSON.parse(await fs.readFile(this.statusPath, 'utf8'));
      await this.atomicJson(this.statusPath, { ...status, running: false, updatedAt: new Date().toISOString() });
    } catch {}
  }
}
