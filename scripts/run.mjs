// Launch electron-vite with a clean environment. Some hosts (e.g. tools embedded in
// VS Code) export ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
import { spawn } from 'node:child_process'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('npx', ['electron-vite', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
