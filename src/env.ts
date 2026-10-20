/** Loads .env before any other module reads process.env. Import it first. */
import { fileURLToPath } from 'node:url'

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  /* no .env: environment variables only */
}
