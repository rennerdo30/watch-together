FROM node:26-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Next.js inlines NEXT_PUBLIC_* values at compile time, so the playback
# engine has to be chosen here rather than at container start. Defaults to
# the legacy two-element path; pass `mse` to build the single-element one.
ARG NEXT_PUBLIC_STREAM_ENGINE=legacy
ENV NEXT_PUBLIC_STREAM_ENGINE=${NEXT_PUBLIC_STREAM_ENGINE}

RUN npm run build

FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Switch to non-root user
USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
