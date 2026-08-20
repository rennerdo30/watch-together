FROM python:3.14-slim

WORKDIR /app

# Install system dependencies including deno for yt-dlp BotGuard/PO token solving
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user FIRST (before installing Deno)
RUN addgroup --system --gid 1001 appgroup && \
    adduser --system --uid 1001 --ingroup appgroup appuser

# Install Deno to a shared location accessible by all users
ENV DENO_INSTALL="/opt/deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/opt/deno sh && \
    chmod -R 755 /opt/deno

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install latest yt-dlp NIGHTLY from GitHub master for SABR streaming fixes
# See: https://github.com/yt-dlp/yt-dlp/issues/12482
RUN pip install --no-cache-dir -U "yt-dlp[default] @ https://github.com/yt-dlp/yt-dlp/archive/master.tar.gz"

# Install yt-dlp PO token plugins:
# - yt-dlp-get-pot: Framework for PO token generation
# - bgutil-ytdlp-pot-provider: Provider that uses deno to solve BotGuard challenges
RUN pip install --no-cache-dir yt-dlp-get-pot bgutil-ytdlp-pot-provider

# Copy application code
COPY . .

# Copy startup script
COPY start.sh .
RUN chmod +x start.sh

# Create the data directory inside the image, owned by the app user.
# `data/` is in .dockerignore, so without this the directory does not exist
# at build time — and a named volume mounted onto a path the image lacks is
# created root-owned, which the non-root process below cannot write to.
# Startup then dies creating its cache/cookie directories.
RUN mkdir -p /app/data

# Fix ownership
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Run the application using the startup script
CMD ["/bin/bash", "./start.sh"]
