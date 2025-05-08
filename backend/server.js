const express = require('express');
const cors = require('cors'); 
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const winston = require('winston');
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('child_process');

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' })
  ]
});

const app = express();
const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  logger.info('Created uploads directory');
}

// Initialize SQLite database
let db;
const initializeDb = async () => {
  try {
    db = await open({
      filename: path.join(__dirname, 'face_database.db'),
      driver: sqlite3.Database
    });
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS faces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        encoding TEXT NOT NULL,
        image_path TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error(`Database initialization error: ${error.message}`);
    process.exit(1);
  }
};

// Function to save base64 image to file
const saveImage = (base64Image, fileName) => {
  return new Promise((resolve, reject) => {
    const base64Data = base64Image.replace(/^data:image\/jpeg;base64,/, '');
    const filePath = path.join(uploadsDir, fileName);
    fs.writeFile(filePath, base64Data, 'base64', (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(filePath);
    });
  });
};

// Routes
app.get('/', (req, res) => {
  res.send('Face Recognition API is running');
});

app.get('/api/faces', async (req, res) => {
  try {
    const faces = await db.all('SELECT id, name, timestamp FROM faces ORDER BY timestamp DESC');
    logger.info(`Retrieved ${faces.length} registered faces`);
    res.json(faces);
  } catch (error) {
    logger.error(`Error retrieving faces: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve registered faces' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, image } = req.body;
    
    if (!name || !image) {
      logger.warn('Registration attempt with missing name or image');
      return res.status(400).json({ error: 'Name and image are required' });
    }

    const timestamp = Date.now();
    const filename = `face_${timestamp}.jpg`;
    const imagePath = await saveImage(image, filename);
    logger.info(`Saved image to ${imagePath}`);
    
    const pythonProcess = exec(
      `python face_encoder.py "${imagePath}" "${name}"`,
      async (error, stdout, stderr) => {
        if (error) {
          logger.error(`Python script error: ${error.message}`);
          return res.status(500).json({ error: 'Face encoding failed' });
        }
        
        if (stderr) {
          logger.error(`Python stderr: ${stderr}`);
        }
        
        try {
          const pythonOutput = JSON.parse(stdout);
          
          if (pythonOutput.error) {
            logger.warn(`Face detection error: ${pythonOutput.error}`);
            return res.status(400).json({ error: pythonOutput.error });
          }
          
          const encodingString = JSON.stringify(pythonOutput.encoding);
          await db.run(
            'INSERT INTO faces (name, encoding, image_path) VALUES (?, ?, ?)',
            [name, encodingString, imagePath]
          );
          
          logger.info(`Successfully registered face for ${name}`);
          res.status(201).json({ message: 'Face registered successfully', name });
        } catch (dbError) {
          logger.error(`Database error: ${dbError.message}`);
          res.status(500).json({ error: 'Failed to save face data' });
        }
      }
    );
  } catch (error) {
    logger.error(`Registration error: ${error.message}`);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Initialize WebSocket Server for face recognition and chat
const wss = new WebSocket.Server({ server });

// Keep track of all active Python processes
const recognitionProcesses = new Map();
const chatProcesses = new Map();

// Function to start or restart chat process
const startChatProcess = (clientId, ws) => {
  try {
    const dbPath = path.join(__dirname, 'face_database.db');
    const chatProcess = spawn('python', ['chat_rag.py', dbPath]);
    chatProcesses.set(clientId, chatProcess);

    let buffer = '';

    chatProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep the last incomplete line in the buffer

      lines.forEach(line => {
        if (line.trim() === '') return;
        try {
          const result = JSON.parse(line);
          if (ws.readyState === WebSocket.OPEN) {
            logger.info(`Chat process output: ${JSON.stringify(result)}`);
            ws.send(JSON.stringify(result));
          }
        } catch (error) {
          logger.error(`Invalid JSON from chat process: ${line}`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ 
              type: 'system', 
              message: 'Chat service encountered an issue. Please try again.' 
            }));
          }
        }
      });
    });

    chatProcess.stderr.on('data', (data) => {
      logger.error(`Chat process error: ${data.toString()}`);
      // Do not send stderr to the frontend
    });

    chatProcess.on('close', (code) => {
      logger.info(`Chat process closed with code ${code}`);
      chatProcesses.delete(clientId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
          type: 'system', 
          message: 'Chat process terminated, restarting...' 
        }));
        setTimeout(() => startChatProcess(clientId, ws), 1000);
      }
    });

    logger.info(`Started chat process for client ${clientId}`);
    return chatProcess;
  } catch (error) {
    logger.error(`Failed to start chat process: ${error.message}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ 
        type: 'system', 
        message: 'Unable to start chat service. Please try again later.' 
      }));
    }
    return null;
  }
};

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const clientId = Date.now().toString();
  let recognitionProcess = null;
  let chatProcess = null;

  const isChatWs = req.url === '/chat';

  logger.info(`New WebSocket connection established: ${isChatWs ? 'Chat' : 'Recognition'} (Client ${clientId})`);

  if (isChatWs) {
    chatProcess = startChatProcess(clientId, ws);

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'query' && chatProcess) {
          logger.info(`Received chat query: ${data.query}`);
          chatProcess.stdin.write(JSON.stringify({
            query: data.query,
            timestamp: Date.now()
          }) + '\n');
        }
      } catch (error) {
        logger.error(`WebSocket chat message error: ${error.message}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'system', 
            message: 'Invalid message format. Please try again.' 
          }));
        }
      }
    });

    ws.on('error', (error) => {
      logger.error(`WebSocket chat error: ${error.message}`);
    });

    ws.on('close', () => {
      logger.info(`WebSocket chat connection closed for client ${clientId}`);
      if (chatProcesses.has(clientId)) {
        const process = chatProcesses.get(clientId);
        if (process) {
          process.kill();
          logger.info(`Terminated chat process for client ${clientId}`);
        }
        chatProcesses.delete(clientId);
      }
    });
  } else {
    const startRecognitionProcess = async () => {
      try {
        const dbPath = path.join(__dirname, 'face_database.db');
        recognitionProcess = spawn('python', ['face_recognition_server.py', dbPath]);
        recognitionProcesses.set(clientId, recognitionProcess);

        let buffer = '';
        recognitionProcess.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          lines.forEach(line => {
            if (line.trim() === '') return;
            try {
              const result = JSON.parse(line);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(result));
              }
            } catch (error) {
              logger.error(`Invalid JSON from recognition process: ${line}`);
            }
          });
        });

        recognitionProcess.stderr.on('data', (data) => {
          logger.error(`Recognition process error: ${data.toString()}`);
        });

        recognitionProcess.on('close', (code) => {
          logger.info(`Recognition process closed with code ${code}`);
          recognitionProcesses.delete(clientId);
        });

        logger.info(`Started recognition process for client ${clientId}`);
      } catch (error) {
        logger.error(`Failed to start recognition process: ${error.message}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ 
            type: 'system', 
            message: 'Failed to start recognition service. Please try again.' 
          }));
        }
      }
    };

    startRecognitionProcess();

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'frame' && recognitionProcess) {
          recognitionProcess.stdin.write(JSON.stringify({
            image: data.image,
            timestamp: Date.now()
          }) + '\n');
        }
      } catch (error) {
        logger.error(`WebSocket recognition message error: ${error.message}`);
      }
    });

    ws.on('close', () => {
      logger.info(`WebSocket recognition connection closed for client ${clientId}`);
      if (recognitionProcesses.has(clientId)) {
        const process = recognitionProcesses.get(clientId);
        if (process) {
          process.kill();
          logger.info(`Terminated recognition process for client ${clientId}`);
        }
        recognitionProcesses.delete(clientId);
      }
    });
  }
});

// Start the server
const startServer = async () => {
  await initializeDb();
  server.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`WebSocket server is ready for face recognition and chat`);
  });
};

startServer();