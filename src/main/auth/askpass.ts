// Routes git/ssh authentication questions to the app.
//
// git and ssh run a small script (written to disk at startup) as GIT_ASKPASS / SSH_ASKPASS,
// and as a URL-scoped credential helper for hosts with a connected account. The script
// relays each request over a local socket guarded by a per-run secret, and the app answers
// from the account store or by asking the user.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Credential {
  username: string
  password: string
}

export interface AskpassHandler {
  /** Credential helper `get`: return a credential for these fields, or null to defer to git. */
  credential(fields: Record<string, string>): Promise<Credential | null>
  /** Askpass prompt: return the answer, or null when the user cancels. */
  prompt(text: string): Promise<string | null>
}

export type PromptKind =
  | { kind: 'username'; url: string }
  | { kind: 'password'; url: string }
  | { kind: 'passphrase'; key: string }
  | { kind: 'hostkey' }
  | { kind: 'text'; secret: boolean }

/** Classifies a prompt from git or OpenSSH. */
export function classifyPrompt(text: string): PromptKind {
  const user = /^Username for '([^']+)'/.exec(text)
  if (user) return { kind: 'username', url: user[1] }
  const pass = /^Password for '([^']+)'/.exec(text)
  if (pass) return { kind: 'password', url: pass[1] }
  const key = /^Enter passphrase for (?:key )?'?([^':]+)'?/.exec(text)
  if (key) return { kind: 'passphrase', key: key[1] }
  if (/continue connecting \(yes\/no/i.test(text)) return { kind: 'hostkey' }
  return { kind: 'text', secret: /password|passphrase|token|pin/i.test(text) }
}

/** Removes `user@` from a URL so username and password prompts share a cache key. */
export function stripUser(url: string): string {
  return url.replace(/^([a-z][a-z+.-]*:\/\/)[^@/]*@/i, '$1')
}

// The relay is CommonJS JavaScript run by the app's own binary in Node mode
// (ELECTRON_RUN_AS_NODE), so it needs nothing installed.
const RELAY_JS = `const net = require('net')
const [, , first, ...rest] = process.argv
function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (data += d))
    process.stdin.on('end', () => resolve(data))
  })
}
async function main() {
  let request
  if (first === 'credential') {
    // Only "get" is answered; gitdesk keeps tokens itself, so store/erase are no-ops.
    if (rest[0] !== 'get') return 0
    const fields = {}
    for (const line of (await readStdin()).split('\\n')) {
      const i = line.indexOf('=')
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1).replace(/\\r$/, '')
    }
    request = { type: 'credential', fields }
  } else request = { type: 'prompt', prompt: [first, ...rest].join(' ') }
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(process.env.GITDESK_ASKPASS_SOCKET)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\\n')
      if (nl >= 0) {
        resolve(JSON.parse(buf.slice(0, nl)))
        socket.end()
      }
    })
    socket.on('error', reject)
    socket.write(JSON.stringify({ secret: process.env.GITDESK_ASKPASS_SECRET, ...request }) + '\\n')
  })
  if (request.type === 'credential') {
    if (reply.username !== undefined) process.stdout.write('username=' + reply.username + '\\npassword=' + reply.password + '\\n')
    return 0
  }
  if (reply.answer === null || reply.answer === undefined) return 1
  process.stdout.write(reply.answer + '\\n')
  return 0
}
main().then((code) => process.exit(code), () => process.exit(1))
`

/** sh is available to both git (Git for Windows ships it) and ssh on every platform. */
function relaySh(): string {
  return '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "$GITDESK_NODE" "$GITDESK_ASKPASS_JS" "$@"\n'
}

/** Paths handed to git's sh must use forward slashes on Windows. */
function forward(p: string): string {
  return p.replace(/\\/g, '/')
}

export class AskpassServer {
  private server?: Server
  private socketPath = ''
  private readonly secret = randomBytes(32).toString('hex')
  private shPath = ''
  private jsPath = ''

  constructor(
    private readonly handler: AskpassHandler,
    /** Binary that runs the relay in Node mode: the Electron executable, or node in tests. */
    private readonly nodeBinary: string
  ) {}

  async start(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true })
    this.jsPath = join(dir, 'askpass.js')
    this.shPath = join(dir, 'askpass.sh')
    await fs.writeFile(this.jsPath, RELAY_JS)
    await fs.writeFile(this.shPath, relaySh(), { mode: 0o755 })
    await fs.chmod(this.shPath, 0o755)
    const id = `${process.pid}-${randomBytes(6).toString('hex')}`
    this.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\gitdesk-${id}` : join(tmpdir(), `gitdesk-${id}.sock`)
    this.server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.socketPath, () => resolve())
    })
  }

  private serve(socket: Socket): void {
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('data', async (d: string) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      let reply: unknown = { answer: null }
      try {
        const req = JSON.parse(buf.slice(0, nl))
        // Reject anything that does not carry this process's secret.
        if (req.secret !== this.secret) return socket.destroy()
        if (req.type === 'credential') {
          const c = await this.handler.credential(req.fields ?? {})
          reply = c ? { username: c.username, password: c.password } : {}
        } else {
          reply = { answer: await this.handler.prompt(String(req.prompt ?? '')) }
        }
      } catch {
        reply = { answer: null }
      }
      socket.end(JSON.stringify(reply) + '\n')
    })
  }

  /** Environment for every git process. */
  env(): Record<string, string> {
    return {
      GIT_ASKPASS: forward(this.shPath),
      SSH_ASKPASS: forward(this.shPath),
      // Make OpenSSH use askpass even without a display or when it thinks it has a tty.
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      GITDESK_NODE: forward(this.nodeBinary),
      GITDESK_ASKPASS_JS: forward(this.jsPath),
      GITDESK_ASKPASS_SOCKET: this.socketPath,
      GITDESK_ASKPASS_SECRET: this.secret
    }
  }

  /**
   * `-c` arguments that make the relay the only credential helper for the given URL scopes
   * (e.g. https://gitlab.nexon.com).
   * The empty value resets helpers configured earlier (system/global) for that URL only,
   * so other hosts keep using the user's own helpers.
   */
  configArgs(scopes: string[]): string[] {
    const args: string[] = []
    for (const scope of scopes) {
      const key = `credential.${scope}.helper`
      args.push('-c', `${key}=`, '-c', `${key}=!'${forward(this.shPath)}' credential`)
    }
    return args
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}
