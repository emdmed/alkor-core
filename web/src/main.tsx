import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The type system, delivered rather than assumed. DESIGN.md committed to Adwaita Sans, which
// is Inter with cv05 frozen -- so before this import the committed face resolved on GNOME
// desktops and nowhere else. Inter Variable carries the whole 100-900 axis in one latin file,
// which is what lets styles.css ask for weights like 650 and 750 and actually get them.
// Each @font-face is unicode-range scoped, so a latin page fetches only the latin subset.
import '@fontsource-variable/inter/wght.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/600.css'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)