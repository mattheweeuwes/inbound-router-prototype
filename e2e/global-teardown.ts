import { rmSync } from 'node:fs';

/** Remove the throwaway database and output folder the test server used. */
export default function globalTeardown() {
  const dir = process.env.E2E_DATA_DIR;
  if (dir && /router-e2e-/.test(dir)) rmSync(dir, { recursive: true, force: true });
}
