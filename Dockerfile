# Use an official, lightweight Python image
FROM python:3.11-slim

# Set the working directory inside the container
WORKDIR /app

# Copy the requirements file first (this makes rebuilding faster if you only change code)
COPY requirements.txt .

# Install the Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy your actual application code into the container
COPY . .

# Expose the port the app runs on
EXPOSE 8000

# Tell Docker how to start your app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]