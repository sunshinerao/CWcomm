import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { useTranslation } from './i18n';
import ClientPage from './pages/ClientPage';
import AdminPage from './pages/AdminPage';

function App() {
  const { t, lang, setLang } = useTranslation();

  return (
    <BrowserRouter>
      <div className="nav-bar">
        <h1>{t('title')}</h1>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
          <Link to="/" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Client</Link>
          <Link to="/admin" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>Admin</Link>
          <select 
            value={lang} 
            onChange={e => setLang(e.target.value as any)}
            style={{ width: '100px', padding: '6px' }}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <div className="container">
        <Routes>
          <Route path="/" element={<ClientPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
