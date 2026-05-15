# lzz AI — VS Code 扩展

一个轻量级的 Visual Studio Code 扩展，让你可以直接在编辑器中查询 Ollama 模型。

## 功能特性

- 向本地 Ollama 模型发送提示词
- 使用选中文本作为提示词，或手动输入提示词
- 在侧边栏 Chat 视图中查看模型回复（支持 Markdown 渲染）
- 在只读 Markdown 文档中查看回复
- 将回复复制到剪贴板
- 配置 Ollama 命令行路径、模型、温度和令牌上限

## 使用方法

1. 本地安装 Ollama：https://ollama.com
2. 打开 VS Code，运行命令：`lzz: Ask AI`
3. 在调用命令前选中文本，即可将选中内容作为提示词
4. 或直接使用命令手动输入提示词
5. 也可以点击侧边栏的 lzz AI 图标，在 Chat 视图中交互对话

## 命令

- `lzz: Ask AI` — 使用选中文本或输入提示词
- `lzz: Ask AI from Selection` — 需要先选中文本
- `lzz: Ask AI and Copy Response` — 将回复复制到剪贴板
- `lzz: Select Local Model` — 选择本地 Ollama 模型

## 设置项

- `ollamaAi.cliPath`：Ollama 命令行工具的路径。
- `ollamaAi.backend`：选择使用本地 Ollama 命令行工具（`cli`）还是本地 HTTP 接口（`http`）。
- `ollamaAi.httpUrl`：Ollama 或兼容模型服务器的本地 HTTP 接口地址。
- `ollamaAi.autoExecuteCommand`：当配置的触发条件满足时自动执行命令。
- `ollamaAi.autoExecuteOnSelectionChange`：当活动选区变化时自动执行选定的命令。
- `ollamaAi.autoExecuteOnSave`：当活动文本文档保存时自动执行选定的命令。
- `ollamaAi.autoExecuteDebounceMs`：自动命令执行的去抖延迟（毫秒）。
- `ollamaAi.timeoutMs`：命令行和 HTTP 后端调用的请求超时时间（毫秒）。
- `ollamaAi.retryCount`：发生超时或临时错误时的重试次数。
- `ollamaAi.retryDelayMs`：临时错误后重试前的延迟时间（毫秒）。
- `ollamaAi.model`：用于提示词的 Ollama 模型名称。
- `ollamaAi.temperature`：Ollama 模型的温度参数。
- `ollamaAi.maxTokens`：Ollama 回复的最大令牌数。
- `ollamaAi.openResponseAsMarkdown`：以 Markdown 文档而非纯文本编辑器打开 AI 回复。

## 开发

```sh
npm install
npm run compile
```

## 打包

```sh
npm run package
```

生成的 `.vsix` 文件位于 `release/` 目录。

## 许可证

Apache-2.0

