// Load .env.local (etc.) into process.env for tests, the same way Next does.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
