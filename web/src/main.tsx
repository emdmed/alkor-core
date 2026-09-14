import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The type system, delivered rather than assumed. The alkor ledger world names two faces and
// calls neither optional: Archivo carries language, Spline Sans Mono carries anything a reader
// compares character by character. Both are bundled rather than fetched from Google Fonts,
// because this dashboard runs beside a local model on someone's own machine and is expected to
// work with no network at all -- a webfont link would degrade to the nearest installed
// grotesque exactly where the system says that is a failure rather than a fallback.
//
// Both are variable and carry their whole weight axis in one latin file, which is what lets
// styles.css ask for weights like 550 and 650 and actually get them. Each @font-face is
// unicode-range scoped, so a latin page fetches only the latin subset.
import '@fontsource-variable/archivo/wght.css'
import '@fontsource-variable/spline-sans-mono/wght.css'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)