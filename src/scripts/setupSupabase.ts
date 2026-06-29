import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import dotenv from 'dotenv';
import { config } from '../config.js';

dotenv.config();

const dbUrl = config.supabaseDbUrl();
if (!dbUrl) {
  console.error('Falta SUPABASE_DB_URL. Alternativa: pegá supabase/schema.sql en Supabase SQL Editor.');
  process.exit(1);
}

const sqlPath = path.resolve(process.cwd(), 'supabase/schema.sql');
const schema = fs.readFileSync(sqlPath, 'utf8');
const sql = postgres(dbUrl, { ssl: 'require' });

try {
  await sql.unsafe(schema);
  console.log('Supabase configurado: tablas y taxonomía creadas.');
} catch (error) {
  console.error('Error creando Supabase:', error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
