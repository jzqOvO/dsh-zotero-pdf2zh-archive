# Zotero PDF2zh 译文自动归档 · DSH 插件

在 Zotero 中使用 PDF2zh + DeepSeek 完成文献翻译后，自动将中文和中英双语 PDF 保存到桌面的 **文献** 文件夹。

这是 DeepSeek Harness（DSH）的原生 Cordis Host bundle。归档过程不调用模型，也不需要读取 DeepSeek API Key。

## 功能

- 每 3 秒读取 PDF2zh 成功任务，自动保存实际生成的中文与双语文件。
- 支持 `.mono.pdf`、`-mono.pdf`、`.dual.pdf`、`-dual.pdf`、`.LR_dual.pdf`、`.TB_dual.pdf`。
- 只有 `.compare.pdf` 时，将其作为双语文件保存；存在标准双语输出时跳过重复 compare 输出。
- 不保存失败或进行中的任务、原始 PDF、裁剪输出和术语表。
- 相同内容去重；同名不同内容追加哈希后缀，保留已有文件。
- 检查文件稳定性和 PDF 首尾标志，保存后校验 SHA-256。
- 保存待归档任务，支持失败重试与重启恢复。
- 无第三方运行时依赖，不需要 npm 安装脚本。

## 已验证环境

| 组件 | 版本 |
| --- | --- |
| Zotero | 10.0.3，64 位 |
| Zotero PDF2zh | 4.1.7 |
| DSH Desktop | 0.2.0-rc.2 |
| 系统 | Windows |

默认连接本机 `http://127.0.0.1:8890`。DSH 仍处于开发预览阶段，其他版本应自行验证。

## 安装

### Windows 桌面版

1. 下载或克隆本仓库。
2. 完全退出 DSH，包括托盘中的后台进程。
3. 如果 DSH 安装在 `E:\dsh`，双击 `install.cmd`。
4. 如果安装在其他位置，在 PowerShell 中运行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DshDirectory 'D:\Apps\dsh'
   ```

5. 重新启动 DSH。

安装器通过 DSH 官方 CLI 安装并选择 bundle；复制位置为 `<DSH安装目录>\plugins\zotero-pdf2zh-archive`。重新安装时保留已有 `config.json`。

### 使用 DSH 插件管理工具

将源码放在固定目录，然后在 DSH 中要求：

> 请用 plugin_manager 的 install_bundle 操作安装本地 bundle：这里填写源码目录的绝对路径。

DSH 对本地 bundle 使用目录链接，请保留源码目录。安装结果若提示需要重启，应完全退出并重启 DSH。

## 使用

1. 保持 DSH 运行，并启动已有的 PDF2zh 服务。
2. 在 Zotero 的 PDF2zh 设置中选择 DeepSeek，同时开启中文（mono）和双语（dual）输出。
3. 照常在 Zotero 中右键翻译。
4. 翻译完成后，译文自动出现在桌面 `文献`：

   ```text
   文献/
   ├── 论文名_中文译文.pdf
   ├── 论文名_中英双语.pdf
   └── .pdf2zh-archive/
       ├── archive.log
       ├── status.json
       └── state.json
   ```

插件只保存 PDF2zh 实际生成的结果，不会主动补译或产生额外模型费用。

## 配置

编辑安装目录中的 `config.json`，然后完全退出并重启 DSH。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `enabled` | `true` | 开启自动归档 |
| `serverUrl` | `http://127.0.0.1:8890` | 本机 PDF2zh 服务 |
| `sourceDirectory` | `null` | 为空时使用服务端 HTTP 下载；设置为译文目录可直接复制 |
| `targetDirectory` | `""` | 为空时自动识别桌面并创建“文献”文件夹 |
| `dataDirectory` | `""` | 为空时保存到目标目录的 `.pdf2zh-archive` |
| `serviceFilter` | `deepseek` | 匹配 PDF2zh 记录的服务名；`*` 接受所有服务 |
| `outputTypes` | `["mono", "dual"]` | 中文与双语都保存 |
| `pollIntervalMs` | `3000` | 轮询间隔，毫秒 |
| `stableMs` | `1500` | 直接复制前检查源文件稳定的等待时间 |
| `requestTimeoutMs` | `10000` | 单次 HTTP 请求超时 |
| `maxPdfBytes` | `268435456` | 单文件大小上限，默认 256 MiB |

如果通过其他服务名称调用 DeepSeek，请将 `serviceFilter` 改为 PDF2zh 实际记录的服务名。

`status.json` 中 `running=true` 表示插件运行，`connected=true` 表示服务连接正常。异常可查 `archive.log`。停用可在 DSH 插件管理中禁用本 bundle。

## 工作边界

- 本版本只连接本机 HTTP 服务。
- DSH 应在翻译期间保持运行。PDF2zh 4.1.7 任务历史只存在内存中，最多 200 条；DSH 关闭期间完成的翻译，在 PDF2zh 重启后无法从已丢失的历史恢复。
- 已捕获的待归档任务会持久化重试，但源 PDF 必须仍存在且未被后来翻译覆盖。
- PDF 首尾检查用于排除明显未完成文件，不代替全面的 PDF 结构验证。

## 开发和验证

需要 Node.js 22 或更新版本，无需安装测试依赖：

```sh
node --test test/archive.test.js
```

15 项测试覆盖双输出归档、服务过滤、批量任务、LR/TB 命名、compare 回退、去重、同名保留、不完整文件重试、状态恢复、HTTP 下载、大小限制与生命周期。

原始实现还通过了本机 DSH 内置 Cordis 的加载/卸载及离线安装测试，并用已有真实双语 PDF 模拟成功任务验证了字节一致性和可解析性。未主动触发付费翻译。

## 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Zotero PDF2zh](https://github.com/guaguastandup/zotero-pdf2zh)

本项目是独立集成插件，不属于上述项目的官方组件。
