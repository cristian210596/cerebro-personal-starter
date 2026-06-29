export type EntidadClasificada = {
  tipo: string;
  nombre: string;
};

export type MemoriaSugerida = {
  afirmacion: string;
  categoria: string;
  confianza: 'Baja' | 'Media' | 'Alta' | string;
};

export type Clasificacion = {
  titulo: string;
  resumen: string;
  categoria_principal: string;
  subcategorias: string[];
  tipo_item: string;
  estado: string | null;
  valoracion: string | null;
  importancia: 'Baja' | 'Media' | 'Alta' | string;
  accion_futura: string | null;
  tags: string[];
  entidades: EntidadClasificada[];
  memorias_sugeridas: MemoriaSugerida[];
};

export type ItemInsert = {
  fuente: string;
  telegram_user_id?: string;
  telegram_chat_id?: string;
  telegram_message_id?: string;
  texto_original: string;
  titulo: string;
  resumen: string;
  categoria_principal: string;
  subcategorias: string[];
  tipo_item: string;
  estado: string | null;
  valoracion: string | null;
  importancia: string;
  accion_futura: string | null;
  tags: string[];
  entidades_json: EntidadClasificada[];
  url?: string | null;
  classifier_json: Clasificacion;
};
