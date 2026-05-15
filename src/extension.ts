import * as vscode from 'vscode'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'

const execFileAsync = promisify(execFile)

type OllamaBackend = 'cli' | 'http'
type OllamaAutoCommand = 'none' | 'askSelection' | 'askAndCopy'

type OllamaConfig = {
  backend: OllamaBackend
  cliPath: string
  httpUrl: string
  model: string
  temperature: number
  maxTokens: number
  openResponseAsMarkdown: boolean
  autoExecuteCommand: OllamaAutoCommand
  autoExecuteOnSelectionChange: boolean
  autoExecuteOnSave: boolean
  autoExecuteDebounceMs: number
  timeoutMs: number
  retryCount: number
  retryDelayMs: number
}

let autoExecuteTimeout: NodeJS.Timeout | undefined

export function activate(context: vscode.ExtensionContext) {
  const provider = new OllamaChatViewProvider(context.extensionUri)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ollamaAi.chatView', provider),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('ollamaAi.ask', () => askOllama(false)),
    vscode.commands.registerCommand('ollamaAi.askSelection', () =>
      askOllama(true),
    ),
    vscode.commands.registerCommand('ollamaAi.askAndCopy', () =>
      askOllama(false, true),
    ),
    vscode.commands.registerCommand('ollamaAi.selectModel', () =>
      selectLocalModel(),
    ),
    vscode.workspace.onDidChangeConfiguration(() =>
      setupAutoExecution(context),
    ),
    vscode.workspace.onDidChangeTextDocument(() =>
      scheduleAutoExecution(context),
    ),
    vscode.workspace.onDidSaveTextDocument(() =>
      triggerAutoExecutionOnSave(context),
    ),
  )

  setupAutoExecution(context)
}

export function deactivate() {
  clearTimeout(autoExecuteTimeout)
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

class OllamaChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ollamaAi.chatView'
  private _view?: vscode.WebviewView
  private _chatHistory: ChatMessage[] = []

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    // 加载本地模型列表并发送给 webview
    const models = await getLocalModels()
    const currentModel = getConfig().model
    this._view?.webview.postMessage({
      command: 'initModels',
      models,
      currentModel,
    })

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'submit') {
        const prompt = message.text
        if (!prompt) {
          return
        }

        // 添加用户消息到历史
        this._chatHistory.push({ role: 'user', content: prompt })

        this._view?.webview.postMessage({ command: 'response', text: '思考中...' })

        try {
          const config = getConfig()
          if (message.model) {
            config.model = message.model
          }

          // 构建带上下文的 prompt
          const contextPrompt = buildContextPrompt(this._chatHistory)

          const response =
            config.backend === 'http'
              ? await askOllamaLocalHttp(config, contextPrompt)
              : await askOllamaCli(config, contextPrompt)

          const responseText = response || '未返回结果。'

          // 添加助手回复到历史
          this._chatHistory.push({ role: 'assistant', content: responseText })

          this._view?.webview.postMessage({
            command: 'response',
            text: responseText,
          })
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          // 出错时移除最后添加的用户消息
          this._chatHistory.pop()
          this._view?.webview.postMessage({
            command: 'response',
            text: '错误: ' + msg,
          })
        }
      } else if (message.command === 'selectModel') {
        const modelName = message.model
        if (modelName) {
          const config = vscode.workspace.getConfiguration('ollamaAi')
          await config.update('model', modelName, vscode.ConfigurationTarget.Global)
          vscode.window.showInformationMessage(`已切换模型为: ${modelName}`)
        }
      } else if (message.command === 'refreshModels') {
        const models = await getLocalModels()
        const currentModel = getConfig().model
        this._view?.webview.postMessage({
          command: 'initModels',
          models,
          currentModel,
        })
      } else if (message.command === 'clearHistory') {
        this._chatHistory = []
      }
    })
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'chat.css'),
    )

    const html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '  <meta charset="UTF-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '  <link rel="stylesheet" href="' + styleUri + '">',
      '  <title>lzz AI Chat</title>',
      '</head>',
      '<body>',
      '  <div id="messages"></div>',
      '  <div class="input-area">',
      '    <div class="model-selector">',
      '      <select id="modelSelect"><option value="">加载模型中...</option></select>',
      '      <button id="refreshBtn" title="刷新模型列表">↻</button>',
      '      <button id="clearBtn" title="清空对话">🗑</button>',
      '    </div>',
      '    <textarea id="promptInput" placeholder="输入问题..." rows="3"></textarea>',
      '    <button id="submitBtn">发送</button>',
      '  </div>',
      '  <script>',
      '    const vscode = acquireVsCodeApi();',
      '    const messagesDiv = document.getElementById("messages");',
      '    const promptInput = document.getElementById("promptInput");',
      '    const submitBtn = document.getElementById("submitBtn");',
      '    const modelSelect = document.getElementById("modelSelect");',
      '    const refreshBtn = document.getElementById("refreshBtn");',
      '    const clearBtn = document.getElementById("clearBtn");',
      '',
      '    function addMessage(role, text) {',
      '      const div = document.createElement("div");',
      '      div.className = "message " + role;',
      '      div.textContent = text;',
      '      messagesDiv.appendChild(div);',
      '      messagesDiv.scrollTop = messagesDiv.scrollHeight;',
      '    }',
      '',
      '    submitBtn.addEventListener("click", () => {',
      '      const text = promptInput.value.trim();',
      '      if (!text) return;',
      '      addMessage("user", text);',
      '      const selectedModel = modelSelect.value;',
      '      vscode.postMessage({ command: "submit", text, model: selectedModel });',
      '      promptInput.value = "";',
      '    });',
      '',
      '    promptInput.addEventListener("keydown", (e) => {',
      '      if (e.key === "Enter" && !e.shiftKey) {',
      '        e.preventDefault();',
      '        submitBtn.click();',
      '      }',
      '    });',
      '',
      '    modelSelect.addEventListener("change", () => {',
      '      const selected = modelSelect.value;',
      '      if (selected) {',
      '        vscode.postMessage({ command: "selectModel", model: selected });',
      '      }',
      '    });',
      '',
      '    refreshBtn.addEventListener("click", () => {',
      '      modelSelect.innerHTML = \'<option value="">加载中...</option>\';',
      '      vscode.postMessage({ command: "refreshModels" });',
      '    });',
      '',
      '    clearBtn.addEventListener("click", () => {',
      '      messagesDiv.innerHTML = \'\';',
      '      vscode.postMessage({ command: "clearHistory" });',
      '    });',
      '',
      '    window.addEventListener("message", (event) => {',
      '      const message = event.data;',
      '      if (message.command === "response") {',
      '        const lastMsg = messagesDiv.lastElementChild;',
      '        if (lastMsg && lastMsg.classList.contains("assistant") && lastMsg.textContent === "思考中...") {',
      '          lastMsg.textContent = message.text;',
      '        } else {',
      '          addMessage("assistant", message.text);',
      '        }',
      '        messagesDiv.scrollTop = messagesDiv.scrollHeight;',
      '      } else if (message.command === "initModels") {',
      '        modelSelect.innerHTML = "";',
      '        if (message.models.length === 0) {',
      '          const opt = document.createElement("option");',
      '          opt.value = "";',
      '          opt.textContent = "未找到本地模型";',
      '          modelSelect.appendChild(opt);',
      '        } else {',
      '          message.models.forEach((m) => {',
      '            const opt = document.createElement("option");',
      '            opt.value = m;',
      '            opt.textContent = m;',
      '            if (m === message.currentModel) {',
      '              opt.selected = true;',
      '            }',
      '            modelSelect.appendChild(opt);',
      '          });',
      '        }',
      '      }',
      '    });',
      '  </script>',
      '</body>',
      '</html>',
    ].join('\n')

    return html
  }
}

function setupAutoExecution(context: vscode.ExtensionContext): void {
  clearTimeout(autoExecuteTimeout)
  const config = getConfig()
  if (config.autoExecuteCommand === 'none') {
    return
  }

  if (config.autoExecuteOnSelectionChange) {
    scheduleAutoExecution(context)
  }
}

function scheduleAutoExecution(context: vscode.ExtensionContext): void {
  const config = getConfig()
  if (
    config.autoExecuteCommand === 'none' ||
    !config.autoExecuteOnSelectionChange
  ) {
    return
  }

  clearTimeout(autoExecuteTimeout)
  autoExecuteTimeout = setTimeout(
    () => executeAutoCommand(config),
    config.autoExecuteDebounceMs,
  )
}

function triggerAutoExecutionOnSave(context: vscode.ExtensionContext): void {
  const config = getConfig()
  if (config.autoExecuteCommand === 'none' || !config.autoExecuteOnSave) {
    return
  }

  executeAutoCommand(config)
}

async function executeAutoCommand(config: OllamaConfig): Promise<void> {
  const selectedText = getSelectedText()
  if (!selectedText) {
    return
  }

  if (config.autoExecuteCommand === 'askSelection') {
    await askOllama(true)
  } else if (config.autoExecuteCommand === 'askAndCopy') {
    await askOllama(true, true)
  }
}

async function askOllama(
  useSelectionOnly: boolean,
  copyResponse = false,
): Promise<void> {
  const config = getConfig()
  const prompt = useSelectionOnly
    ? getSelectedText()
    : await getPromptFromEditor()

  if (!prompt) {
    if (useSelectionOnly) {
      vscode.window.showWarningMessage('请先选择文本，然后重试。')
    }
    return
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'lzz AI: 正在生成回复',
      cancellable: false,
    },
    async () => {
      try {
        const response =
          config.backend === 'http'
            ? await askOllamaLocalHttp(config, prompt)
            : await askOllamaCli(config, prompt)

        if (!response) {
          vscode.window.showInformationMessage('AI 未返回结果。')
          return
        }

        if (copyResponse) {
          await vscode.env.clipboard.writeText(response)
          vscode.window.showInformationMessage('AI 回复已复制到剪贴板。')
        }

        await presentResponse(response, prompt, config)
      } catch (error) {
        await handleExecutionError(error, config.cliPath)
      }
    },
  )
}

function getConfig(): OllamaConfig {
  const config = vscode.workspace.getConfiguration('ollamaAi')
  return {
    backend: (config.get<string>('backend') as OllamaBackend) ?? 'cli',
    cliPath: config.get<string>('cliPath') ?? 'ollama',
    httpUrl:
      config.get<string>('httpUrl') ?? 'http://127.0.0.1:11434/api/prompt',
    model: config.get<string>('model') ?? 'qwen2.5',
    temperature: config.get<number>('temperature') ?? 0.7,
    maxTokens: config.get<number>('maxTokens') ?? 512,
    openResponseAsMarkdown:
      config.get<boolean>('openResponseAsMarkdown') ?? true,
    autoExecuteCommand:
      (config.get<string>('autoExecuteCommand') as OllamaAutoCommand) ?? 'none',
    autoExecuteOnSelectionChange:
      config.get<boolean>('autoExecuteOnSelectionChange') ?? false,
    autoExecuteOnSave: config.get<boolean>('autoExecuteOnSave') ?? false,
    autoExecuteDebounceMs: config.get<number>('autoExecuteDebounceMs') ?? 300,
    timeoutMs: config.get<number>('timeoutMs') ?? 120000,
    retryCount: config.get<number>('retryCount') ?? 2,
    retryDelayMs: config.get<number>('retryDelayMs') ?? 500,
  }
}

function getSelectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    return undefined
  }

  const selection = editor.selection
  const selectedText = editor.document.getText(selection).trim()
  return selectedText.length > 0 ? selectedText : undefined
}

async function getPromptFromEditor(): Promise<string | undefined> {
  const selectedText = getSelectedText()
  if (selectedText) {
    return selectedText
  }

  return vscode.window.showInputBox({
    prompt: '输入提示词',
    placeHolder: '例如：请总结所选代码、翻译文本或回答问题。',
    ignoreFocusOut: true,
  })
}

async function askOllamaCli(
  config: OllamaConfig,
  prompt: string,
): Promise<string> {
  return retryOperation(async () => {
    const args = [
      'run',
      config.model,
    ]

    return new Promise<string>((resolve, reject) => {
      const child = spawn(config.cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('命令超时'))
      }, config.timeoutMs)

      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })

      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(stderr.trim() || `进程退出，退出码 ${code}`))
        } else {
          resolve(parseOllamaOutput(stdout, stderr))
        }
      })

      child.stdin.write('请用中文回答以下问题：\n' + prompt)
      child.stdin.end()
    })
  }, config)
}

async function askOllamaLocalHttp(
  config: OllamaConfig,
  prompt: string,
): Promise<string> {
  return retryOperation(async () => {
    const responseText = await performHttpPost(
      config.httpUrl,
      {
        model: config.model,
        prompt: '请用中文回答以下问题：\n' + prompt,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      },
      config.timeoutMs,
    )
    return parseOllamaOutput(responseText, '')
  }, config)
}

function performHttpPost(
  urlString: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString)
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
      const request = transport(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk.toString()
          })
          res.on('end', () => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              resolve(data)
            } else {
              reject(new Error('HTTP ' + res.statusCode + ': ' + data))
            }
          })
        },
      )

      request.on('error', (error) => {
        reject(error)
      })

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error('请求超时'))
      })

      request.write(JSON.stringify(body))
      request.end()
    } catch (error) {
      reject(error)
    }
  })
}

async function retryOperation<T>(
  operation: () => Promise<T>,
  config: OllamaConfig,
): Promise<T> {
  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      attempt += 1
      if (attempt > config.retryCount || !isRetryableError(error)) {
        throw error
      }
      await delay(config.retryDelayMs * attempt)
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('超时') ||
    message.includes('econnreset') ||
    message.includes('ecanceled') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('interrupted') ||
    message.includes('请求超时')
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseOllamaOutput(stdout: string, stderr: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return stderr.trim()
  }

  try {
    const parsed = JSON.parse(trimmed)

    if (typeof parsed === 'string') {
      return parsed
    }

    if (Array.isArray(parsed)) {
      return parsed.map((item) => JSON.stringify(item, null, 2)).join('\n\n')
    }

    if (parsed?.completion) {
      return String(parsed.completion)
    }

    if (parsed?.text) {
      return String(parsed.text)
    }

    if (parsed?.response) {
      return String(parsed.response)
    }

    return JSON.stringify(parsed, null, 2)
  } catch {
    return trimmed
  }
}

async function presentResponse(
  response: string,
  prompt: string,
  config: OllamaConfig,
): Promise<void> {
  const content = config.openResponseAsMarkdown
    ? '# AI 回复\n\n**模型:** ' + config.model + '\n**提示词:** ' + prompt + '\n\n---\n\n' + response
    : response

  const language = config.openResponseAsMarkdown ? 'markdown' : 'plaintext'
  const document = await vscode.workspace.openTextDocument({
    content,
    language,
  })
  await vscode.window.showTextDocument(document, { preview: false })
}

async function handleExecutionError(
  error: unknown,
  cliPath: string,
): Promise<void> {
  if (error instanceof Error) {
    const message = error.message || String(error)
    if (message.includes('ENOENT')) {
      vscode.window.showErrorMessage(
        '找不到 Ollama 命令行工具：' + cliPath + '。请确保已安装 Ollama 并且配置了正确的路径。',
      )
      return
    }

    vscode.window.showErrorMessage('AI 执行失败：' + message)
    return
  }

  vscode.window.showErrorMessage('Ollama 执行出现未知错误。')
}

function buildContextPrompt(history: ChatMessage[]): string {
  const parts: string[] = []
  for (const msg of history) {
    if (msg.role === 'user') {
      parts.push('用户：' + msg.content)
    } else {
      parts.push('助手：' + msg.content)
    }
  }
  // 最后加上提示，让模型继续回复
  parts.push('请根据以上对话上下文，用中文继续回复：')
  return parts.join('\n\n')
}

async function getLocalModels(): Promise<string[]> {
  const config = getConfig()
  try {
    const { stdout } = await execFileAsync(config.cliPath, ['list'], {
      timeout: 10000,
    })
    const lines = stdout.trim().split('\n')
    // 跳过表头行，解析模型名称（第一列）
    const models: string[] = []
    for (let i = 1; i < lines.length; i++) {
      const name = lines[i].split(/\s+/)[0]
      if (name) {
        models.push(name)
      }
    }
    return models
  } catch {
    return []
  }
}

async function selectLocalModel(): Promise<void> {
  const models = await getLocalModels()

  if (models.length === 0) {
    vscode.window.showWarningMessage('未找到本地已安装的模型。请先使用 ollama pull <模型名> 安装模型。')
    return
  }

  const config = vscode.workspace.getConfiguration('ollamaAi')
  const currentModel = config.get<string>('model') ?? 'qwen2.5'

  const items: vscode.QuickPickItem[] = models.map((model) => ({
    label: model,
    description: model === currentModel ? '当前使用' : undefined,
  }))

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择本地已安装的模型',
    title: 'lzz AI: 选择模型',
  })

  if (selected) {
    await config.update('model', selected.label, vscode.ConfigurationTarget.Global)
    vscode.window.showInformationMessage(`已切换模型为: ${selected.label}`)
  }
}
