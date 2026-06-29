import dotenv from 'dotenv';
import { classifyText } from '../classifier.js';

dotenv.config();

const text = process.argv.slice(2).join(' ') || 'Hoy hice calibración de longitud de onda del HPLC Shimadzu LC-40. Dio pass, pero me quedó duda con el nivel de energía de la lámpara D2.';
const result = await classifyText(text);
console.log(JSON.stringify(result, null, 2));
