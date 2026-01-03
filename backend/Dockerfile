FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
# deno is needed as JS runtime for YouTube extraction
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install deno for yt-dlp JavaScript extraction
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
