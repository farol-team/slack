# Runtime image for the OpenTag SaaS panel. The build (vite + esbuild)
# happens outside; dist/boot.js is self-contained (deps bundled), static
# files are served from dist/public.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY dist ./dist
EXPOSE 8080
CMD ["node", "dist/boot.js"]
