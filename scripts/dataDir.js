import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where runtime JSON state (clubs, applications, gamba, quizzes, ...) lives.
 * Defaults to <repo>/data. Set TAZUNA_DATA_DIR to point somewhere else, e.g. a
 * throwaway temp folder in tests so they never touch the real bot's data.
 */
export const DATA_DIR = process.env.TAZUNA_DATA_DIR
  ? path.resolve(process.env.TAZUNA_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
