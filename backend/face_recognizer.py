# face_recognizer.py
import face_recognition
import json
import numpy as np
import cv2
import base64
import logging
import time
from io import BytesIO
from PIL import Image

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("face_recognition.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class FaceRecognizer:
    def __init__(self, db_connection):
        """
        Initialize the face recognizer with database connection
        """
        self.db = db_connection
        self.known_face_encodings = []
        self.known_face_names = []
        self.face_data = []
        self.last_processed_time = 0
        self.processing_interval = 0.1  # Time in seconds between processing frames
        self.load_known_faces()
        
    def load_known_faces(self):
        """
        Load all known faces from the database
        """
        try:
            logger.info("Loading known faces from database")
            faces = self.db.all("SELECT id, name, encoding FROM faces")
            
            self.known_face_encodings = []
            self.known_face_names = []
            self.face_data = []
            
            for face in faces:
                # Parse the encoding JSON string back to a list
                encoding = json.loads(face['encoding'])
                # Convert to numpy array
                encoding_array = np.array(encoding)
                
                self.known_face_encodings.append(encoding_array)
                self.known_face_names.append(face['name'])
                self.face_data.append({
                    'id': face['id'],
                    'name': face['name']
                })
                
            logger.info(f"Loaded {len(self.known_face_encodings)} known faces")
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
            return np.array(image)
            
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
            # If base64 string, decode it first
            if isinstance(image_data, str):
                image = self.decode_image(image_data)
                if image is None:
                    return {"type": "error", "message": "Invalid image data"}
            else:
                image = image_data
            
            # For better performance, resize image to 1/4 size
            small_image = cv2.resize(image, (0, 0), fx=0.25, fy=0.25)
            
            # Convert from BGR to RGB if needed (OpenCV uses BGR by default)
            if len(small_image.shape) == 3 and small_image.shape[2] == 3:
                rgb_small_image = small_image[:, :, ::-1] if image_data is not str else small_image
            else:
                rgb_small_image = small_image
            
            # Find all face locations and encodings
            start_time = time.time()
            face_locations = face_recognition.face_locations(rgb_small_image)
            face_encodings = face_recognition.face_encodings(rgb_small_image, face_locations)
            
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
    
    def reload_known_faces(self):
        """
        Reload known faces from database (useful after new registrations)
        """
        return self.load_known_faces()