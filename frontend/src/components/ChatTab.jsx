import React, { useState, useEffect, useRef } from 'react';
import './ChatTab.css';

const ChatTab = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [error, setError] = useState('');
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    wsRef.current = new WebSocket('ws://localhost:5000/chat');

    wsRef.current.onopen = () => {
      setConnectionStatus('connected');
      setMessages((prev) => [...prev, { type: 'system', text: 'Connected to chat service' }]);
      setError('');
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'response') {
          setMessages((prev) => [...prev, { type: 'bot', text: data.answer }]);
        } else if (data.type === 'system') {
          setMessages((prev) => [...prev, { type: 'system', text: data.message }]);
        } else if (data.type === 'error') {
          // Log the error to the console instead of displaying it
          console.error('Chat service error:', data.message);
          // Optionally show a generic message to the user
          setMessages((prev) => [...prev, { type: 'system', text: 'An issue occurred while processing your request. Please try again.' }]);
        } else {
          console.error('Unknown response type:', data);
          setMessages((prev) => [...prev, { type: 'system', text: 'Received an unexpected response from the server. Please try again.' }]);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
        setMessages((prev) => [...prev, { type: 'system', text: 'Failed to process the server response. Please try again.' }]);
      }
      scrollToBottom();
    };

    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnectionStatus('error');
      setError('Error connecting to chat service');
    };

    wsRef.current.onclose = () => {
      setConnectionStatus('disconnected');
      setMessages((prev) => [...prev, { type: 'system', text: 'Disconnected from chat service' }]);
      setError('Chat service disconnected');
      scrollToBottom();
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const handleSend = () => {
    if (!input.trim()) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setMessages((prev) => [...prev, { type: 'user', text: input }]);
      wsRef.current.send(JSON.stringify({ type: 'query', query: input }));
      setInput('');
      scrollToBottom();
    } else {
      setError('Not connected to chat service');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSend();
    }
  };

  return (
    <div className="chat-container">
      <h2>Chat Query</h2>
      <div className="status-indicator">
        <span className={`status-dot ${connectionStatus}`}></span>
        <span>Chat Service: {connectionStatus}</span>
      </div>
      {error && <div className="error-message">{error}</div>}
      <div className="chat-window">
        {messages.map((msg, index) => (
          <div key={index} className={`message ${msg.type}`}>
            {msg.type === 'user' && <span className="user-label">You: </span>}
            {msg.type === 'bot' && <span className="bot-label">Bot: </span>}
            {msg.type === 'system' && <span className="system-label">System: </span>}
            <span>{msg.text}</span>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-container">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Ask about registered faces..."
          className="chat-input"
        />
        <button onClick={handleSend} className="send-button">
          Send
        </button>
      </div>
    </div>
  );
};

export default ChatTab;