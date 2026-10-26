// Única parte que hay que editar para personalizar la web.
export const config = {
  trip: {
    name: "Nuestro viaje",
    destination: "Destino por definir",
    start: "2026-12-20", // AAAA-MM-DD; dejar "" si aún no hay fechas
    end: "2026-12-27",
    currency: "EUR",
  },

  map: {
    // Vista inicial mientras no haya lugares con ubicación: [longitud, latitud] y zoom.
    // Ahora apunta a Florida; cambiarlo al destino real.
    center: [-81.5, 27.8],
    zoom: 6,
    // Teselas gratuitas de OpenFreeMap (sin clave).
    styles: {
      light: "https://tiles.openfreemap.org/styles/liberty",
      dark: "https://tiles.openfreemap.org/styles/dark",
    },
  },

  // Dejar url y anonKey vacíos = modo demo (datos solo en este navegador).
  // La anon key es pública por diseño: la protección son las políticas RLS de supabase/schema.sql.
  // Nunca poner aquí la service_role key.
  supabase: {
    url: "https://fpzwtgnsewjiywczoyfx.supabase.co",
    anonKey: "sb_publishable_kZOPev2MMba_F65RkandkQ_mB9TAAEs", // clave pública (publishable): es segura en el código
  },

  // Ayudas de IA (✨): APAGADAS en esta web. Con `enabled: false` no sale ningún botón ✨, ni la tarjeta «IA» de Ajustes, ni avisos en el
  // panel de estado, y no se pregunta nada a Supabase. Para usarlas: poner `true` (o borrar este bloque) y seguir «IA en la app» de
  // docs/DESPLIEGUE.md (desplegar la función `ia` y guardar la clave en los Secrets de Supabase).
  ia: { enabled: false },
};
