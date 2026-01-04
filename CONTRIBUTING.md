# Contributing to Watch Together

Thank you for considering contributing to Watch Together!

## Development Setup

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local frontend development)
- Python 3.11+ (for local backend development)

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/rennerdo30/watch-together.git
   cd watch-together
   ```

2. Copy environment file:
   ```bash
   cp .env.example .env
   ```

3. Start with Docker:
   ```bash
   docker compose up -d --build
   ```

4. Or run services locally:
   ```bash
   # Backend
   cd backend
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   uvicorn main:app --reload --port 8000

   # Frontend (new terminal)
   cd frontend
   npm install
   npm run dev
   ```

## Code Style

### Frontend (TypeScript/React)
- Use functional components with hooks
- Use TypeScript for all new code
- Follow existing patterns for component structure

### Backend (Python)
- Use type hints
- Follow PEP 8 style guidelines
- Use async/await for I/O operations

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Reporting Issues

Please use GitHub Issues to report bugs or request features. Include:
- Clear description of the issue
- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Screenshots if applicable
