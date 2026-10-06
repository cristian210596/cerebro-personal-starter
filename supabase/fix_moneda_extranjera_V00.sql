-- fix_moneda_extranjera_V00.sql
-- Corrige consumos en moneda extranjera (MXN, EUR, BRL, etc.) de resúmenes Visa Galicia
-- que el parser viejo guardó con moneda ARS aunque el importe ya estaba en dólares.
-- Ejemplo: "17-03-26 K 7 ELEVEN T2679 FORUM MXN 372,00 720716 21,24" quedó como ARS 21,24
-- cuando son USD 21,24.
-- Correr el PASO 1 primero y revisar el listado antes de ejecutar el PASO 2.

-- PASO 1: vista previa (no modifica nada)
select i.id, i.fecha_movimiento, i.descripcion_original, i.monto, i.moneda,
       m.id as movimiento_id, m.moneda as moneda_movimiento
from finanzas_movimientos_importados i
left join finanzas_movimientos m on m.movimiento_importado_id = i.id
where i.moneda = 'ARS'
  and coalesce(i.raw_json->>'line', i.raw_json->>'text', '') ~*
      '\m(MXN|EUR|BRL|CLP|UYU|PYG|BOB|PEN|COP|GBP|CAD|AUD|NZD|CHF|JPY|CNY|DOP|CRC|GTQ) -?[0-9.]+,[0-9]{2} [0-9]{5,8} -?[0-9.]+,[0-9]{2}'
order by i.fecha_movimiento;

-- PASO 2: corrección (en transacción)
begin;

with afectados as (
  update finanzas_movimientos_importados i
     set moneda = 'USD', updated_at = now()
   where i.moneda = 'ARS'
     and coalesce(i.raw_json->>'line', i.raw_json->>'text', '') ~*
         '\m(MXN|EUR|BRL|CLP|UYU|PYG|BOB|PEN|COP|GBP|CAD|AUD|NZD|CHF|JPY|CNY|DOP|CRC|GTQ) -?[0-9.]+,[0-9]{2} [0-9]{5,8} -?[0-9.]+,[0-9]{2}'
  returning i.id
)
update finanzas_movimientos m
   set moneda = 'USD', updated_at = now()
  from afectados a
 where m.movimiento_importado_id = a.id
   and m.moneda = 'ARS';

-- Verificación: debe devolver 0 filas
select count(*) as quedan_mal
from finanzas_movimientos_importados i
where i.moneda = 'ARS'
  and coalesce(i.raw_json->>'line', i.raw_json->>'text', '') ~*
      '\m(MXN|EUR|BRL|CLP|UYU|PYG|BOB|PEN|COP|GBP|CAD|AUD|NZD|CHF|JPY|CNY|DOP|CRC|GTQ) -?[0-9.]+,[0-9]{2} [0-9]{5,8} -?[0-9.]+,[0-9]{2}';

commit;
