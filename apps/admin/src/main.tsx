import React from 'react';
import ReactDOM from 'react-dom/client';

function App() {
  return <h1>Gateway Admin</h1>;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
