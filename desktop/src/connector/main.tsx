import React from 'react'
import ReactDOM from 'react-dom/client'
import { LanguageProvider } from '../contexts/LanguageContext'
import ConnectorApp from './App'
import '../index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      <ConnectorApp />
    </LanguageProvider>
  </React.StrictMode>,
)
