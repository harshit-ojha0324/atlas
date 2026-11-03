import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { MotionConfig } from 'motion/react'
import '@fontsource-variable/cinzel'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
)
