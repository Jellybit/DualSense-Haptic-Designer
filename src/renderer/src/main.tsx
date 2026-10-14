import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)

// Debug handle for the dev console / automated UI checks
import { dualSense } from './device/hid'
import { tracker, virtualTilt } from './store'
Object.assign(window, { dshd: { dualSense, tracker, virtualTilt } })
