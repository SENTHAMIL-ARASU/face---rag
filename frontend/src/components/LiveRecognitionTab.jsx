// src/components/LiveRecognitionTab.jsx
import React, { useState, useRef, useEffect } from 'react';
import './LiveRecognitionTab.css';

const LiveRecognitionTab = () => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [recognizedFaces, setRecognizedFaces] = useState([]);
  const [fps, setFps] = useState(1); // Default 1 frame per second
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  const [message, setMessage] = useState('');
  
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const wsRef = useRef(null);
  const processingRef = useRef(false);
  const frameIntervalRef = useRef(null);

  // Setup WebSocket connection
  useEffect(() => {
    return () => {
      // Cleanup on component unmount
      stopStream();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    wsRef.current = new WebSocket('ws://localhost:5000/ws');
    
    wsRef.current.onopen = () => {
      setConnectionStatus('connected');
      setMessage('WebSocket connected. Ready to start recognition.');
    };
    
    wsRef.current.onclose = () => {
      setConnectionStatus('disconnected');
      setMessage('WebSocket disconnected.');
      setIsStreaming(false);
      clearInterval(frameIntervalRef.current);
    };
    
    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setMessage('Error connecting to the recognition service.');
      setConnectionStatus('error');
    };
    
    wsRef.current.onmessage = (event) => {
      try {
        const response = JSON.parse(event.data);
        
        if (response.type === 'recognition_result') {
          setRecognizedFaces(response.faces);
          drawFaceBoxes(response.faces);
        } else if (response.type === 'error') {
          setMessage(`Error: ${response.message}`);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
      
      // Mark processing as complete
      processingRef.current = false;
    };
  };

  const startStream = async () => {
    try {
      // Connect WebSocket if not already connected
      if (connectionStatus !== 'connected') {
        connectWebSocket();
      }
      
      // Access camera
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        } 
      });
      
      videoRef.current.srcObject = stream;
      streamRef.current = stream;
      
      // Setup canvas with same dimensions as video
      const video = videoRef.current;
      video.onloadedmetadata = () => {
        canvasRef.current.width = video.videoWidth;
        canvasRef.current.height = video.videoHeight;
        
        setIsStreaming(true);
        setMessage('Stream started. Recognition is active.');
        
        // Start sending frames at the specified FPS
        frameIntervalRef.current = setInterval(() => {
          captureAndSendFrame();
        }, 1000 / fps);
      };
      
    } catch (error) {
      console.error('Error accessing camera:', error);
      setMessage('Failed to access camera. Please ensure camera permissions are granted.');
    }
  };

  const stopStream = () => {
    setIsStreaming(false);
    
    if (streamRef.current) {
      const tracks = streamRef.current.getTracks();
      tracks.forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    
    clearInterval(frameIntervalRef.current);
    setMessage('Stream stopped.');
    
    // Clear canvas
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const captureAndSendFrame = () => {
    // Skip if we're still processing the previous frame or WebSocket is not ready
    if (processingRef.current || 
        !wsRef.current || 
        wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (!video || !canvas || video.paused || video.ended) {
      return;
    }
    
    const ctx = canvas.getContext('2d');
    
    // Draw video frame to canvas (mirror image for selfie view)
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Get frame as base64 image
    const imageData = canvas.toDataURL('image/jpeg', 0.8);
    
    // Mark as processing to avoid sending too many frames
    processingRef.current = true;
    
    // Send frame for recognition
    wsRef.current.send(JSON.stringify({
      type: 'frame',
      image: imageData
    }));
  };

  const drawFaceBoxes = (faces) => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    // Clear previous drawings while keeping the video frame
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);
    
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(videoRef.current, -canvas.width, 0, canvas.width, canvas.height);
    ctx.restore();
    
    // Draw bounding boxes for each recognized face
    faces.forEach(face => {
      const { left, top, right, bottom, name, confidence } = face;
      
      // Adjust coordinates for mirrored display
      const mirroredLeft = canvas.width - right;
      
      // Draw rectangle
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#00FF00';
      ctx.strokeRect(mirroredLeft, top, right - left, bottom - top);
      
      // Draw name label
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(mirroredLeft, top - 25, right - left, 25);
      
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '16px Arial';
      ctx.fillText(`${name} (${Math.round(confidence * 100)}%)`, mirroredLeft + 5, top - 5);
    });
  };

  const handleFpsChange = (e) => {
    const newFps = parseInt(e.target.value);
    setFps(newFps);
    
    // Update the frame capture interval if streaming
    if (isStreaming) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = setInterval(() => {
        captureAndSendFrame();
      }, 1000 / newFps);
    }
  };

  return (
    <div className="live-recognition-container">
      <h2>Live Face Recognition</h2>
      
      <div className="video-container">
        <video 
          ref={videoRef} 
          autoPlay 
          muted 
          playsInline
          className={isStreaming ? 'active mirrored' : 'inactive'}
        />
        <canvas 
          ref={canvasRef} 
          className={isStreaming ? 'active' : 'inactive'}
        />
        
        {!isStreaming && (
          <div className="camera-placeholder">
            <span>Camera off</span>
          </div>
        )}
      </div>
      
      <div className="controls">
        {!isStreaming ? (
          <button onClick={startStream} className="btn primary">Start Recognition</button>
        ) : (
          <button onClick={stopStream} className="btn danger">Stop Recognition</button>
        )}
        
        <div className="fps-control">
          <label htmlFor="fps">Processing Rate:</label>
          <select 
            id="fps" 
            value={fps} 
            onChange={handleFpsChange} 
            disabled={isStreaming}
          >
            <option value="0.5">0.5 FPS (Low CPU)</option>
            <option value="1">1 FPS (Normal)</option>
            <option value="2">2 FPS (Higher CPU)</option>
          </select>
        </div>
      </div>
      
      {message && <div className="message">{message}</div>}
      
      <div className="status-indicator">
        <span className={`status-dot ${connectionStatus}`}></span>
        <span>Recognition Service: {connectionStatus}</span>
      </div>
      
      <div className="recognized-persons">
        <h3>Recognized Faces ({recognizedFaces.length})</h3>
        {recognizedFaces.length > 0 ? (
          <ul className="face-list">
            {recognizedFaces.map((face, index) => (
              <li key={index} className="face-item">
                <span className="face-name">{face.name}</span>
                <span className="face-confidence">{Math.round(face.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{isStreaming ? 'No faces recognized' : 'Start recognition to detect faces'}</p>
        )}
      </div>
    </div>
  );
};

export default LiveRecognitionTab;