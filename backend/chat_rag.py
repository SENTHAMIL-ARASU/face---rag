import sys
import json
import sqlite3
import logging
import time
import random
from langchain_openai import OpenAIEmbeddings, ChatOpenAI
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnablePassthrough
from langchain_core.output_parsers import StrOutputParser
import os
from datetime import datetime
from dotenv import load_dotenv
import backoff
import openai
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type
)

# Configure logging to file and console for better debugging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("chat_rag.log"),
        logging.StreamHandler()  # Added console handler for immediate feedback
    ]
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    logger.error("OPENAI_API_KEY not found in .env file")
    print(json.dumps({"type": "error", "message": "API key is missing. Please contact the administrator."}), flush=True)
    sys.exit(1)

# Define a retry decorator for OpenAI API calls
@retry(
    retry=retry_if_exception_type((openai.RateLimitError, openai.APIError, openai.APIConnectionError)),
    wait=wait_exponential(multiplier=1, min=4, max=60),
    stop=stop_after_attempt(5)
)
def create_embeddings_with_retry(embeddings, documents):
    """Create embeddings with retry logic for rate limiting"""
    try:
        logger.info(f"Attempting to create embeddings for {len(documents)} documents")
        return FAISS.from_documents(documents, embeddings)
    except Exception as e:
        logger.error(f"Error creating embeddings: {str(e)}")
        if "429" in str(e) or "rate limit" in str(e).lower():
            logger.warning("Rate limit hit, waiting before retry...")
            raise openai.RateLimitError("Rate limit exceeded")
        raise

class ChatRAG:
    def __init__(self, db_path):
        self.db_path = db_path
        self.vector_store = None
        self.llm = None
        self.embeddings = None
        self.has_data = False
        self.load_data()

    def load_data(self):
        """Load face data from SQLite database and create vector store"""
        try:
            self.embeddings = OpenAIEmbeddings(
                api_key=OPENAI_API_KEY,
                retry_min_seconds=4,
                retry_max_seconds=60,
                max_retries=5
            )
            self.llm = ChatOpenAI(
                model="gpt-4o-mini", 
                api_key=OPENAI_API_KEY,
                temperature=0.7,
                request_timeout=60,
                max_retries=5
            )
            logger.info("Initialized OpenAI embeddings and LLM")

            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            logger.info(f"Connected to database at: {self.db_path}")
            
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='faces'")
            if not cursor.fetchone():
                logger.error("Faces table does not exist in the database")
                print(json.dumps({"type": "system", "message": "No face data available. Please register faces first."}), flush=True)
                conn.close()
                return

            cursor.execute("SELECT id, name, timestamp FROM faces ORDER BY timestamp")
            faces = cursor.fetchall()
            
            logger.info(f"Found {len(faces)} faces in database")
            
            if faces:
                sample = faces[0]
                logger.info(f"Sample face: ID={sample['id']}, Name={sample['name']}, Timestamp={sample['timestamp']}")
            
            conn.close()

            if not faces:
                logger.warning("No face records found in database")
                print(json.dumps({"type": "system", "message": "No faces found in database. Please register faces first."}), flush=True)
                return

            documents = []
            for face in faces:
                doc_content = f"Name: {face['name']}, Registered at: {face['timestamp']}, ID: {face['id']}"
                documents.append(Document(page_content=doc_content, metadata={"id": face["id"], "name": face["name"], "timestamp": face["timestamp"]}))
                logger.info(f"Added document for face: {face['name']}")

            if documents:
                try:
                    self.vector_store = create_embeddings_with_retry(self.embeddings, documents)
                    logger.info(f"Successfully loaded {len(documents)} face records into vector store")
                    self.has_data = True
                    print(json.dumps({"type": "system", "message": f"Successfully loaded {len(documents)} faces into the chat system"}), flush=True)
                except Exception as e:
                    logger.error(f"Failed to create vector store after retries: {str(e)}")
                    logger.info(f"Using simple storage mode for {len(documents)} faces due to API limitations.")  # Log to console only
                    self.documents = documents
                    self.has_data = True
            else:
                logger.warning("No documents created from database records")

        except sqlite3.Error as e:
            logger.error(f"SQLite error: {str(e)}")
            print(json.dumps({"type": "system", "message": "Unable to access face data. Please try again later."}), flush=True)
            self.vector_store = None
        except Exception as e:
            logger.error(f"Error loading data: {str(e)}")
            print(json.dumps({"type": "system", "message": "Chat system is currently unavailable. Please try again later."}), flush=True)
            self.vector_store = None

    def simple_search(self, query):
        """Fallback search when vector store is not available"""
        if not hasattr(self, 'documents') or not self.documents:
            return []
        
        query = query.lower()
        results = []
        
        # Improved keyword matching for partial names
        for doc in self.documents:
            doc_content = doc.page_content.lower()
            # Check if the query is a substring of the name in the document
            if 'name:' in doc_content:
                name = doc_content.split('name:')[1].split(',')[0].strip()
                if query in name:
                    results.append(doc)
            elif query in doc_content:
                results.append(doc)
        
        # If no matches, return a few random documents as context
        if not results and self.documents:
            sample_size = min(3, len(self.documents))
            results = random.sample(self.documents, sample_size)
            
        return results

    @retry(
        retry=retry_if_exception_type((openai.RateLimitError, openai.APIError)),
        wait=wait_exponential(multiplier=1, min=4, max=30),
        stop=stop_after_attempt(3)
    )
    def _call_llm(self, prompt):
        try:
            return self.llm.invoke(prompt).content
        except Exception as e:
            logger.error(f"LLM call failed: {str(e)}")
            if "429" in str(e) or "rate limit" in str(e).lower():
                raise openai.RateLimitError("Rate limit exceeded")
            raise

    def query(self, question):
        """Process a query using RAG or fallback to simpler method"""
        try:
            if not self.has_data:
                logger.warning("No data available to query")
                return {
                    "type": "response",
                    "answer": "No face data is available to query. Please register some faces first."
                }

            context = ""
            docs = []

            question_lower = question.lower()
            
            # Check if the query is asking for the last person to register
            if "last" in question_lower and "register" in question_lower:
                # Retrieve all documents and sort by timestamp
                if self.vector_store:
                    try:
                        # Retrieve all documents to ensure we get the most recent one
                        retriever = self.vector_store.as_retriever(search_kwargs={"k": 1000})
                        all_docs = retriever.invoke(question)
                        logger.info(f"Retrieved {len(all_docs)} documents for query: {question}")
                    except Exception as e:
                        logger.error(f"Vector retrieval failed: {str(e)}")
                        all_docs = self.documents if hasattr(self, 'documents') else []
                        logger.info(f"Used fallback retrieval, found {len(all_docs)} documents")
                else:
                    all_docs = self.documents if hasattr(self, 'documents') else []
                    logger.info(f"Used simple retrieval, found {len(all_docs)} documents")

                # Sort documents by timestamp in descending order
                sorted_docs = sorted(
                    all_docs,
                    key=lambda doc: datetime.strptime(doc.metadata["timestamp"], "%Y-%m-%d %H:%M:%S"),
                    reverse=True
                )

                # Take the most recent document
                if sorted_docs:
                    docs = [sorted_docs[0]]  # Only the most recent one
                    logger.info(f"Selected most recent document: {docs[0].page_content}")
                else:
                    docs = []

            # Check if the query is asking for the total number of registered people
            elif "how many" in question_lower and "register" in question_lower:
                # Retrieve all documents for counting purposes
                if self.vector_store:
                    try:
                        retriever = self.vector_store.as_retriever(search_kwargs={"k": 1000})
                        docs = retriever.invoke(question)
                        logger.info(f"Retrieved {len(docs)} documents for query: {question}")
                        for i, doc in enumerate(docs):
                            logger.info(f"Doc {i+1}: {doc.page_content}")
                    except Exception as e:
                        logger.error(f"Vector retrieval failed: {str(e)}")
                        docs = self.documents if hasattr(self, 'documents') else []
                        logger.info(f"Used fallback retrieval, found {len(docs)} documents")
                else:
                    docs = self.documents if hasattr(self, 'documents') else []
                    logger.info(f"Used simple retrieval, found {len(docs)} documents")
            else:
                # Default retrieval logic for other queries
                if self.vector_store:
                    try:
                        retriever = self.vector_store.as_retriever(search_kwargs={"k": 3})
                        docs = retriever.invoke(question)
                        logger.info(f"Retrieved {len(docs)} documents for query: {question}")
                        for i, doc in enumerate(docs):
                            logger.info(f"Doc {i+1}: {doc.page_content}")
                    except Exception as e:
                        logger.error(f"Vector retrieval failed: {str(e)}")
                        docs = self.simple_search(question)
                        logger.info(f"Used fallback retrieval, found {len(docs)} documents")
                else:
                    docs = self.simple_search(question)
                    logger.info(f"Used simple retrieval, found {len(docs)} documents")

            context = "\n".join(doc.page_content for doc in docs)

            prompt_template = f"""You are a helpful assistant that answers questions about registered faces based on the provided context. 
            Use the context to provide accurate answers. If the information is not available, say so clearly.
            
            Context: {context}
            
            Question: {question}
            
            Answer in a concise and natural manner. If you're not sure about some details, you can say that 
            the information is not available in the database."""

            try:
                answer = self._call_llm(prompt_template)
                logger.info(f"Query: {question}, Answer: {answer}")
                return {
                    "type": "response",
                    "answer": answer.strip()
                }
            except openai.RateLimitError:
                logger.warning("Rate limit hit when calling LLM, providing canned response")
                if "who" in question_lower or "name" in question_lower:
                    names = [doc.metadata.get("name") for doc in docs if "name" in doc.metadata]
                    if names:
                        return {
                            "type": "response",
                            "answer": f"I found these names in our database: {', '.join(names)}. I cannot provide more detailed information at the moment due to service limitations."
                        }
                
                return {
                    "type": "response",
                    "answer": "I'm currently experiencing high demand and cannot process your query with full capabilities. Please try again in a few minutes or phrase your question in a simpler way."
                }

        except Exception as e:
            logger.error(f"Error processing query '{question}': {str(e)}")
            return {
                "type": "response",
                "answer": "I'm sorry, I couldn't process your query due to a technical issue. Please try again later."
            }

def main():
    if len(sys.argv) < 2:
        logger.error("Usage: python chat_rag.py <database_path>")
        print(json.dumps({"type": "system", "message": "Chat system failed to start. Please contact the administrator."}), flush=True)
        sys.exit(1)

    db_path = sys.argv[1]
    if not os.path.exists(db_path):
        logger.error(f"Database file not found: {db_path}")
        print(json.dumps({"type": "system", "message": "Chat system failed to start. Database not found."}), flush=True)
        sys.exit(1)

    print(json.dumps({"type": "system", "message": f"Initializing chat system with database: {db_path}"}), flush=True)
    
    rag = ChatRAG(db_path)

    if rag.has_data:
        print(json.dumps({"type": "system", "message": "Chat system is ready. You can ask questions about registered faces."}), flush=True)
    else:
        print(json.dumps({"type": "system", "message": "Chat system initialized, but no face data is available. Please register faces first."}), flush=True)

    for line in sys.stdin:
        try:
            input_data = json.loads(line.strip())
            query = input_data.get('query')
            if query:
                if query.lower() == "reload database" or query.lower() == "refresh data":
                    rag.load_data()
                    print(json.dumps({
                        "type": "system",
                        "message": "Database reloaded" if rag.has_data else "No face data available after reload"
                    }), flush=True)
                else:
                    result = rag.query(query)
                    print(json.dumps(result), flush=True)
            else:
                logger.error("No query provided in input")
                print(json.dumps({
                    "type": "response",
                    "answer": "Please provide a query to proceed."
                }), flush=True)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON input: {str(e)}")
            print(json.dumps({
                "type": "response",
                "answer": "Invalid input format. Please try again."
            }), flush=True)
        except Exception as e:
            logger.error(f"Error processing input: {str(e)}")
            print(json.dumps({
                "type": "response",
                "answer": "An unexpected issue occurred. Please try again later."
            }), flush=True)

if __name__ == "__main__":
    main()