# face_encoder.py
import face_recognition
import json
import sys
import os
import cv2
import logging

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

def encode_face(image_path, name):
    """
    Detect faces in an image and encode them.
    Returns face encoding for the first face found.
    """
    try:
        # Load image
        logger.info(f"Loading image from {image_path}")
        image = face_recognition.load_image_file(image_path)
        
        # Find all face locations in the image
        face_locations = face_recognition.face_locations(image)
        
        if not face_locations:
            logger.warning(f"No faces detected in {image_path}")
            return {"error": "No faces detected in the image. Please try again."}
        
        if len(face_locations) > 1:
            logger.warning(f"Multiple faces detected in {image_path}")
            return {"error": "Multiple faces detected. Please ensure only one face is in the image."}
        
        # Generate encodings
        logger.info(f"Generating face encoding for {name}")
        face_encoding = face_recognition.face_encodings(image, face_locations)[0]
        
        # Save face location for reference (optional)
        top, right, bottom, left = face_locations[0]
        
        # Draw rectangle around the face on a copy of the image for verification (optional)
        verification_image = cv2.imread(image_path)
        cv2.rectangle(verification_image, (left, top), (right, bottom), (0, 255, 0), 2)
        
        # Save the verification image
        verification_path = image_path.replace('.jpg', '_verified.jpg')
        cv2.imwrite(verification_path, verification_image)
        logger.info(f"Saved verification image to {verification_path}")
        
        # Convert numpy array to list for JSON serialization
        encoding_list = face_encoding.tolist()
        
        return {
            "encoding": encoding_list,
            "name": name,
            "location": {
                "top": top,
                "right": right,
                "bottom": bottom,
                "left": left
            }
        }
        
    except Exception as e:
        logger.error(f"Error in face encoding: {str(e)}")
        return {"error": f"Error processing image: {str(e)}"}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        logger.error("Usage: python face_encoder.py <image_path> <name>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    name = sys.argv[2]
    
    if not os.path.exists(image_path):
        logger.error(f"Image file not found: {image_path}")
        print(json.dumps({"error": "Image file not found"}))
        sys.exit(1)
    
    result = encode_face(image_path, name)
    print(json.dumps(result))