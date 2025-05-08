// src/components/RegistrationTab.jsx
import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import './RegistrationTab.css';

const RegistrationTab = () => {
  const [isCapturing, setIsCapturing] = useState(false);
  const [capturedImage, setCapturedImage] = useState(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [registeredFaces, setRegisteredFaces] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  // Fetch registered faces on component mount
  useEffect(() => {
    fetchRegisteredFaces();
  }, []);

  const fetchRegisteredFaces = async () => {
    try {
      const response = await axios.get('http://localhost:5000/api/faces');
      setRegisteredFaces(response.data);
    } catch (error) {
      console.error('Error fetching registered faces:', error);
      setMessage('Failed to load registered faces');
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoRef.current.srcObject = stream;
      streamRef.current = stream;
      setIsCapturing(true);
      setMessage('Camera started. Position your face and capture.');
    } catch (error) {
      console.error('Error accessing camera:', error);
      setMessage('Failed to access camera. Please ensure camera permissions are granted.');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      const tracks = streamRef.current.getTracks();
      tracks.forEach(track => track.stop());
      videoRef.current.srcObject = null;
      setIsCapturing(false);
    }
  };

  const captureImage = () => {
    if (!videoRef.current) return;

    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    
    const imageDataUrl = canvas.toDataURL('image/jpeg');
    setCapturedImage(imageDataUrl);
    setMessage('Image captured. Enter a name and register.');
  };

  const registerFace = async () => {
    if (!capturedImage || !name.trim()) {
      setMessage('Please capture an image and enter a name');
      return;
    }

    setIsLoading(true);
    try {
      const response = await axios.post('http://localhost:5000/api/register', {
        name: name.trim(),
        image: capturedImage
      });
      
      setMessage(`Registration successful: ${response.data.message}`);
      setCapturedImage(null);
      setName('');
      fetchRegisteredFaces(); // Refresh the list
    } catch (error) {
      console.error('Registration error:', error);
      setMessage(`Registration failed: ${error.response?.data?.error || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  const clearCapture = () => {
    setCapturedImage(null);
    setMessage('Image cleared. Capture again.');
  };

  return (
    <div className="registration-container">
      <h2>Face Registration</h2>
      
      <div className="video-container">
        {!capturedImage ? (
          <video
            ref={videoRef}
            autoPlay
            muted
            className={isCapturing ? 'active' : 'inactive'}
          />
        ) : (
          <div className="captured-image-container">
            <img src={capturedImage} alt="Captured" className="captured-image" />
          </div>
        )}
      </div>

      <div className="controls">
        {!isCapturing && !capturedImage && (
          <button onClick={startCamera} className="btn primary">Start Camera</button>
        )}
        
        {isCapturing && !capturedImage && (
          <>
            <button onClick={captureImage} className="btn success">Capture</button>
            <button onClick={stopCamera} className="btn danger">Stop Camera</button>
          </>
        )}
        
        {capturedImage && (
          <>
            <div className="input-group">
              <input
                type="text"
                placeholder="Enter name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="name-input"
              />
            </div>
            <button 
              onClick={registerFace} 
              disabled={isLoading || !name.trim()} 
              className="btn success"
            >
              {isLoading ? 'Registering...' : 'Register Face'}
            </button>
            <button onClick={clearCapture} className="btn secondary">Clear</button>
            <button onClick={startCamera} className="btn primary">Retake</button>
          </>
        )}
      </div>

      {message && <div className="message">{message}</div>}

      <div className="registered-faces">
        <h3>Registered Faces ({registeredFaces.length})</h3>
        {registeredFaces.length > 0 ? (
          <ul className="face-list">
            {registeredFaces.map(face => (
              <li key={face.id} className="face-item">
                <span className="face-name">{face.name}</span>
                <span className="face-timestamp">{new Date(face.timestamp).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No faces registered yet.</p>
        )}
      </div>
    </div>
  );
};

export default RegistrationTab;