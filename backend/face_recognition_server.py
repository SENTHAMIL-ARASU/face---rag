# face_recognition_server.py
import sys
import os
import json
import signal
import sqlite3
import numpy as np
import logging
import time
from io import BytesIO
import base64
from PIL import Image
import face_recognition
import cv2

# Custom StreamHandler to direct logs to stdout
class StdoutStreamHandler(logging.StreamHandler):
    def __init__(self):
        super().__init__(stream=sys.stdout)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("face_recognition_server.log"),
        StdoutStreamHandler()  # Direct logs to stdout instead of stderr
    ]
)
logger = logging.getLogger(__name__)

class FaceRecognitionServer:
    def __init__(self, db_path):
        """
        Initialize the face recognition server with database path
        """
        self.db_path = db_path
        self.known_face_encodings = []
        self.known_face_names = []
        self.last_processed_time = 0
        self.processing_interval = 0.1  # Time in seconds between processing frames
        
        # Load known faces
        self.load_known_faces()
        
        logger.info(f"Face Recognition Server initialized with {len(self.known_face_encodings)} known faces")
    
    def load_known_faces(self):
        """
        Load all known faces from the database
        """
        try:
            # Connect to SQLite database
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Query all faces
            cursor.execute("SELECT id, name, encoding FROM faces")
            faces = cursor.fetchall()
            
            self.known_face_encodings = []
            self.known_face_names = []
            
            for face in faces:
                # Parse the encoding JSON string back to a list
                encoding = json.loads(face['encoding'])
                # Convert to numpy array
                encoding_array = np.array(encoding)
                
                self.known_face_encodings.append(encoding_array)
                self.known_face_names.append(face['name'])
            
            conn.close()
            logger.info(f"Loaded {len(self.known_face_encodings)} known faces from database")
            return True
            
        except Exception as e:
            logger.error(f"Error loading known faces: {str(e)}")
            return False
    
    def decode_image(self, base64_image):
        """
        Decode base64 image string to a numpy array
        """
        try:
            # Remove header if present
            if "data:image" in base64_image:
                base64_image = base64_image.split(",")[1]
                
            image_data = base64.b64decode(base64_image)
            image = Image.open(BytesIO(image_data))
            
            # Convert PIL image to numpy array (RGB)
            image_array = np.array(image)
            
            # Ensure the image is in RGB format with uint8
            if image_array.ndim != 3 or image_array.shape[2] != 3:
                logger.error("Image must be in RGB format")
                return None
            if image_array.dtype != np.uint8:
                image_array = image_array.astype(np.uint8)
            
            return image_array
            
        except Exception as e:
            logger.error(f"Error decoding image: {str(e)}")
            return None
    
    def recognize_faces(self, image_data):
        """
        Recognize faces in the provided image data
        """
        current_time = time.time()
        
        # Rate limiting to avoid excessive CPU usage
        if current_time - self.last_processed_time < self.processing_interval:
            return {"type": "error", "message": "Processing too many frames, please slow down"}
        
        self.last_processed_time = current_time
        
        try:
            # Decode base64 image
            image = self.decode_image(image_data)
            if image is None:
                return {"type": "error", "message": "Invalid image data"}
            
            # For better performance, resize image to 1/4 size
            small_frame = cv2.resize(image, (0, 0), fx=0.25, fy=0.25)
            
            # Since decode_image returns RGB, no need to convert
            rgb_small_frame = small_frame
            
            # Find all face locations and encodings
            start_time = time.time()
            face_locations = face_recognition.face_locations(rgb_small_frame)
            if not face_locations:
                logger.info("No faces detected in frame")
                return {
                    "type": "recognition_result",
                    "faces": [],
                    "process_time": time.time() - start_time
                }
            
            logger.info(f"Image shape: {rgb_small_frame.shape}, dtype: {rgb_small_frame.dtype}")
            logger.info(f"Face locations: {face_locations}")
            
            face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)
            
            # Scale back face locations to original image size
            original_face_locations = [(top * 4, right * 4, bottom * 4, left * 4) 
                                      for (top, right, bottom, left) in face_locations]
            
            recognized_faces = []
            
            for i, (face_encoding, face_location) in enumerate(zip(face_encodings, original_face_locations)):
                # Compare with known faces
                if len(self.known_face_encodings) > 0:
                    # Use face_distance to calculate similarity
                    face_distances = face_recognition.face_distance(self.known_face_encodings, face_encoding)
                    best_match_index = np.argmin(face_distances)
                    confidence = 1 - face_distances[best_match_index]
                    
                    # Only consider it a match if confidence is above threshold
                    if confidence > 0.6:
                        name = self.known_face_names[best_match_index]
                    else:
                        name = "Unknown"
                else:
                    name = "Unknown"
                    confidence = 0.0
                
                # Get face location coordinates
                top, right, bottom, left = face_location
                
                recognized_faces.append({
                    "name": name,
                    "confidence": float(confidence if 'confidence' in locals() else 0.0),
                    "top": top,
                    "right": right,
                    "bottom": bottom,
                    "left": left
                })
            
            process_time = time.time() - start_time
            logger.info(f"Recognized {len(recognized_faces)} faces in {process_time:.2f} seconds")
            
            return {
                "type": "recognition_result",
                "faces": recognized_faces,
                "process_time": process_time
            }
            
        except Exception as e:
            logger.error(f"Error in face recognition: {str(e)}")
            return {"type": "error", "message": f"Recognition error: {str(e)}"}

def signal_handler(sig, frame):
    """Handle termination signals"""
    logger.info("Shutting down face recognition server...")
    sys.exit(0)

if __name__ == "__main__":
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    if len(sys.argv) < 2:
        logger.error("Usage: python face_recognition_server.py <database_path>")
        sys.exit(1)
    
    db_path = sys.argv[1]
    if not os.path.exists(db_path):
        logger.error(f"Database file not found: {db_path}")
        sys.exit(1)
    
    # Initialize face recognition server
    server = FaceRecognitionServer(db_path)
    
    # Process input from stdin (frames sent by Node.js)
    for line in sys.stdin:
        try:
            input_data = json.loads(line)
            image_data = input_data.get('image')
            
            if image_data:
                # Process the frame and recognize faces
                result = server.recognize_faces(image_data)
                
                # Send result back to Node.js
                print(json.dumps(result), flush=True)
        except json.JSONDecodeError:
            logger.error("Failed to parse JSON input")
        except Exception as e:
            logger.error(f"Error processing frame: {str(e)}")
            print(json.dumps({
                "type": "error",
                "message": f"Error processing frame: {str(e)}"
            }), flush=True)