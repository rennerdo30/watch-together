FROM python:3.11-slim

WORKDIR /app

# Install system dependencies including deno for yt-dlp BotGuard/PO token solving
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno (required for yt-dlp to solve YouTube's BotGuard challenges)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install latest yt-dlp NIGHTLY from GitHub master for SABR streaming fixes
# See: https://github.com/yt-dlp/yt-dlp/issues/12482
RUN pip install --no-cache-dir -U "yt-dlp[default] @ https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz"

# Install yt-dlp PO token plugins:
# - yt-dlp-get-pot: Framework for PO token generation
# - bgutil-ytdlp-pot-provider: Provider that uses deno to solve BotGuard challenges (from GitHub)
RUN pip install --no-cache-dir yt-dlp-get-pot
RUN pip install --no-cache-dir bgutil-ytdlp-pot-provider

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
