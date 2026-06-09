import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          color: '#fff', background: '#0b0d17', minHeight: '100vh',
          padding: '40px', fontFamily: 'monospace', fontSize: '14px'
        }}>
          <h2 style={{ color: '#ff6b81' }}>Erro ao inicializar o app</h2>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ffd166' }}>
            {this.state.error?.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#94a3b8', fontSize: '12px' }}>
            {this.state.error?.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
