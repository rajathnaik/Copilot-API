import React from 'react'
import ReactDOM from 'react-dom/client'
import { LanguageProvider } from '@copilot-api/shared/language'
import ConnectorApp from './App'
import '../index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <ConnectorApp />
    </LanguageProvider>
  </React.StrictMode>,
)
