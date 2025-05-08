import React, { useState } from 'react';
import RegistrationTab from './components/RegistrationTab';
import LiveRecognitionTab from './components/LiveRecognitionTab';
import ChatTab from './components/ChatTab';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState('registration');

  return (
    <div className="App">
      <header className="app-header">
        <h1>Face Recognition Platform</h1>
        <nav className="app-nav">
          <button 
            className={`nav-tab ${activeTab === 'registration' ? 'active' : ''}`}
            onClick={() => setActiveTab('registration')}
          >
            Registration
          </button>
          <button 
            className={`nav-tab ${activeTab === 'recognition' ? 'active' : ''}`}
            onClick={() => setActiveTab('recognition')}
          >
            Live Recognition
          </button>
          <button 
            className={`nav-tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            Chat Query
          </button>
        </nav>
      </header>
      <main className="app-main">
        {activeTab === 'registration' ? (
          <RegistrationTab />
        ) : activeTab === 'recognition' ? (
          <LiveRecognitionTab />
        ) : (
          <ChatTab />
        )}
      </main>
      <footer className="app-footer">
        <p>This project is a part of a hackathon run by https://katomaran.com</p>
      </footer>
    </div>
  );
}

export default App;